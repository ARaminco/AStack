import { CliChannel } from "./cli.mjs";
import { TelegramChannel } from "./telegram.mjs";
import { WapiChannel } from "./whatsapp-wapi.mjs";
import { WhatsAppBridgeChannel } from "./whatsapp-bridge.mjs";
import { WhatsAppCloudChannel } from "./whatsapp-cloud.mjs";

/**
 * Channel adapters. Each one implements:
 *   configured() health() poll({ cursor, timeoutS, signal }) sendText() sendFile()
 *   downloadVoice() normalizeId() aliases()
 * and a webhook channel adds handleVerify() / handleWebhook().
 */
export const channelTypes = {
  cli: CliChannel,
  "whatsapp-wapi": WapiChannel,
  "whatsapp-bridge": WhatsAppBridgeChannel,
  "whatsapp-cloud": WhatsAppCloudChannel,
  telegram: TelegramChannel
};

export { CliChannel, TelegramChannel, WapiChannel, WhatsAppBridgeChannel, WhatsAppCloudChannel };
