import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(""); // Start with an empty session

(async () => {
  console.log("Starting interactive login process...");

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Enter your phone number: "),
    phoneCode: async () => await input.text("Enter the code you received: "),
    onError: (err) => console.log(err),
  });

  const newSession = client.session.save();
  console.log("\nLogin successful! Your session string is:\n");
  console.log(newSession);

  // Update .env automatically
  try {
    const envPath = ".env";
    let envContent = "";
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, "utf8");
    }

    if (envContent.includes("SESSION_STRING")) {
        const updatedEnv = envContent.replace(
            /^SESSION_STRING=.*$/m,
            `SESSION_STRING=${newSession}`
        );
        fs.writeFileSync(envPath, updatedEnv);
    } else {
        fs.appendFileSync(envPath, `\nSESSION_STRING=${newSession}`);
    }
    console.log("\nSession string saved to .env file. You can now start the alert job.");
  } catch (err) {
      console.error("\nError saving session string to .env file:", err);
      console.log("Please manually add the session string above to your .env file.");
  }

  // Disconnect the client after login
  await client.disconnect();
  process.exit(0);

})();