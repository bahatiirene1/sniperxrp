import Redis from "ioredis";
import { Client } from "xrpl";
import axios from "axios";
import dotenv from "dotenv";
import logger from "./logger.js";

dotenv.config();

const botToken = process.env.BOT_TOKEN;
const botChatId = process.env.BOT_CHAT_ID;

const redisClient = new Redis();
const xrplClient = new Client("wss://s1.ripple.com/");

const activeListeners = new Set();

function escapeMarkdownV2(text) {
    // Escape characters for Telegram's MarkdownV2 parser
    return text.toString().replace(/([_*`\[\]()~>#+\-=|\"{}"'.!\\])/g, '\\$1');
}

async function sendTelegramNotification(message) {
    try {
        const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        await axios.post(telegramApiUrl, {
            chat_id: botChatId,
            text: message,
            parse_mode: "MarkdownV2",
        });
        logger.info("Telegram notification sent successfully.");
    } catch (err) {
        logger.error("Failed to send Telegram notification:", err);
        if (err.response) {
            logger.error("Telegram API Error:", err.response.data);
        }
    }
}

async function handleNewToken(message) {
    try {
        const parsedData = JSON.parse(message);
        const { token, issuer, supply } = parsedData;
        const uniqueId = `${issuer}.${token}`;

        if (activeListeners.has(uniqueId)) {
            logger.warn(`Already listening for AMM creation for ${token}`);
            return;
        }

        logger.info(`New token detected: ${token}. Listening for AMM creation...`);
        activeListeners.add(uniqueId);

        xrplClient.on("transaction", async (tx) => {
            if (
                tx.transaction.TransactionType === "AMMCreate" &&
                tx.validated &&
                typeof tx.transaction.Amount !== 'string' && // Not an XRP transaction
                tx.transaction.Amount.issuer === issuer &&
                tx.transaction.Amount.currency === token
            ) {
                logger.info(`AMMCreate transaction found for ${token}`);

                // Unsubscribe to stop listening
                activeListeners.delete(uniqueId);
                logger.debug(`Unsubscribed from ${token}`);


                try {
                    const ammInfo = await xrplClient.request({
                        command: "amm_info",
                        asset: { currency: token, issuer: issuer },
                        asset2: { currency: "XRP" },
                    });
                    logger.debug("AMM info fetched successfully", ammInfo);

                    const amount1 = ammInfo.result.amm.amount;
                    const amount2 = ammInfo.result.amm.amount2;

                    const tokenAmount = typeof amount1 === 'object' ? amount1 : amount2;
                    const xrpAmount = typeof amount1 === 'string' ? amount1 : amount2;

                    const liquidityXRP = parseInt(xrpAmount) / 1_000_000;
                    const poolSupply = parseFloat(tokenAmount.value);
                    const initialSupply = parseFloat(supply.replace(/,/g, ''));
                    const devAllocation = ((initialSupply - poolSupply) / initialSupply) * 100;
                    const initialPrice = liquidityXRP / poolSupply;

                    const notificationMessage = `
🚀 *AMM Pool is LIVE!* 🚀

*Token:* ${escapeMarkdownV2(token)}
*Initial Price:* ${escapeMarkdownV2(initialPrice.toPrecision(6))} XRP
*Liquidity:* ${escapeMarkdownV2(liquidityXRP.toLocaleString())} XRP
*Pool Supply:* ${escapeMarkdownV2(poolSupply.toLocaleString())} ${escapeMarkdownV2(token)}
*Dev Allocation:* ${escapeMarkdownV2(devAllocation.toFixed(2))}%\n\nLet's trade! 💰
                    `;

                    await sendTelegramNotification(notificationMessage);

                } catch (err) {
                    logger.error("Error fetching AMM info or sending notification:", err);
                }
            }
        });
    } catch (error) {
        logger.error("Error handling new token:", error);
    }
}


(async () => {
    try {
        logger.info("Starting AMM listener service...");
        await xrplClient.connect();
        logger.info("Connected to XRPL");

        await xrplClient.request({
            command: "subscribe",
            streams: ["transactions"],
        });
        logger.info("Subscribed to XRPL transactions stream");

        redisClient.subscribe("newtokens", (err, count) => {
            if (err) {
                logger.error("Failed to subscribe to Redis channel:", err);
                return;
            }
            logger.info(`Subscribed to ${count} channel(s). Waiting for new tokens...`);
        });

        redisClient.on("message", (channel, message) => {
            if (channel === "newtokens") {
                logger.debug(`Received message from ${channel}: ${message}`);
                handleNewToken(message).catch(error => logger.error("Error in handleNewToken:", error));
            }
        });

        process.on('SIGINT', async () => {
            logger.info("Shutting down AMM listener...");
            await xrplClient.disconnect();
            redisClient.quit();
            process.exit(0);
        });
    } catch (error) {
        logger.error("Unhandled exception in AMM listener:", error);
        process.exit(1);
    }
})();

