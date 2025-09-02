
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import axios from "axios";
import dotenv from "dotenv";
import Redis from "ioredis";

dotenv.config();

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const sessionString = process.env.SESSION_STRING;

const botToken = process.env.BOT_TOKEN;
const botChatId = process.env.BOT_CHAT_ID;
const channelUsername = process.env.CHANNEL_USERNAME;

// CRITICAL: Check for session string
if (!sessionString) {
  console.error("SESSION_STRING not found in .env file.");
  console.error("Please run 'node login.js' first to generate a session string.");
  process.exit(1); // Exit with an error code
}

const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 5,
});

const redisClient = new Redis();

redisClient.on("error", (err) => console.log("Redis Client Error", err));

function parseMessage(message) {
  const tokenRegex = /📈 (.*)/;
  const issuerRegex = /(r[a-zA-Z0-9]{24,})/;
  const supplyRegex = /Supply: (.*)/;

  const tokenMatch = message.match(tokenRegex);
  const issuerMatch = message.match(issuerRegex);
  const supplyMatch = message.match(supplyRegex);

  if (tokenMatch && issuerMatch && supplyMatch) {
    return {
      token: tokenMatch[1],
      issuer: issuerMatch[1],
      supply: supplyMatch[1],
    };
  }

  return null;
}

(async () => {
  console.log("Starting Telegram alert service...");

  try {
    await client.start({});
    console.log("Client started successfully using saved session.");

    const channel = await client.getEntity(channelUsername);
    console.log("Monitoring channel:", channelUsername);

    client.addEventHandler(async (event) => {
      if (
        !event.message ||
        !event.message.message ||
        !event.message.peerId ||
        !event.message.peerId.channelId
      ) {
        return;
      }

      // Filter messages to only come from the specified channel
      if (event.message.peerId.channelId.toString() !== channel.id.toString()) {
        return;
      }

      const message = event.message.message;
      console.log("New message detected from the correct channel:", message);

      const parsedData = parseMessage(message);

      if (parsedData) {
        const dataToPublish = {
          ...parsedData,
          timestamp: new Date().toISOString(),
          source: "firstledger.net",
        };
        console.log("Data to publish:", dataToPublish);
        try {
          await redisClient.publish("newtokens", JSON.stringify(dataToPublish));
          console.log("Data published to Redis channel 'newtokens'");

          // Send Telegram notification
          const messageText = `✅ *New token launch confirmed* ✅\n\n*Source:* ${dataToPublish.source}\n*Ticker:* ${dataToPublish.token}\n*Issuer:* ${dataToPublish.issuer}\n*Total Supply:* ${dataToPublish.supply}\n*Date:* ${dataToPublish.timestamp.replace(
            /([!.'-]{1})/g,
            "\\$1"
          )}\n\n⏳ Waiting for AMM pool... ⏳`;

          const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
          await axios.post(telegramApiUrl, {
            chat_id: botChatId,
            text: messageText,
            parse_mode: "MarkdownV2",
          });
          console.log("Telegram notification sent successfully.");

        } catch (err) {
          console.error("Failed to publish to Redis or send Telegram notification:", err);
          if (err.response) {
            console.error("Telegram API Error:", err.response.data);
          }
        }
      }
    });

    console.log("Waiting for new messages...");

  } catch (err) {
    console.error("Failed to start the client:", err);
    process.exit(1);
  }
})();
