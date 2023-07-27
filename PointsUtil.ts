import {
	Client,
	Events,
	GatewayIntentBits,
	NewsChannel,
	Snowflake,
	TextChannel
} from "discord.js";
import {WebSocket} from "ws";

const config: {
	token: string,
	source_guild_id: Snowflake,
	clan_source: Snowflake,
	solo_source: Snowflake,
	zombie_source: Snowflake,
	versus_source: Snowflake,
	primary_guild_id: Snowflake,
	clan_target: Snowflake,
	solo_target: Snowflake,
	zombie_target: Snowflake,
	versus_target: Snowflake,
	filtered_data: { [key: string]: { guild_id: Snowflake, channel_id: Snowflake } },
	websocket_url: string,
	websocket_secret: string
} = require("./config.json");

const client = new Client({intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]});

let filteredCopy: { [key: Snowflake]: { [key: string]: TextChannel | NewsChannel } } = {};
let simpleCopy: { [key: Snowflake]: TextChannel | NewsChannel } = {};
let websocketTarget: { [key: string]: boolean } = {};

client.once(Events.ClientReady, async () => {
	let a = client.guilds.cache.get(config.source_guild_id);
	if (!a) throw new Error("Source guild not found");
	let clanSource = a.channels.cache.get(config.clan_source);
	if (!clanSource) throw new Error("Clan source channel not found");
	let b = client.guilds.cache.get(config.primary_guild_id);
	if (b) {
		let clanTarget = b.channels.cache.get(config.clan_target);
		if (clanTarget instanceof TextChannel || clanTarget instanceof NewsChannel) {
			simpleCopy[clanSource.id] = clanTarget;
			websocketTarget[clanSource.id] = true;
		}
		let soloSource = a.channels.cache.get(config.solo_source);
		let soloTarget = b.channels.cache.get(config.solo_target);
		if (soloSource && (soloTarget instanceof TextChannel || soloTarget instanceof NewsChannel)) {
			simpleCopy[soloSource.id] = soloTarget;
			websocketTarget[soloSource.id] = true;
		}
		let zombieSource = a.channels.cache.get(config.zombie_source);
		let zombieTarget = b.channels.cache.get(config.zombie_target);
		if (zombieSource && (zombieTarget instanceof TextChannel || zombieTarget instanceof NewsChannel)) {
			simpleCopy[zombieSource.id] = zombieTarget;
			websocketTarget[zombieSource.id] = true;
		}
		let versusSource = a.channels.cache.get(config.versus_source);
		let versusTarget = b.channels.cache.get(config.versus_target);
		if (versusSource && (versusTarget instanceof TextChannel || versusTarget instanceof NewsChannel)) {
			simpleCopy[versusSource.id] = versusTarget;
		}
	}

	filteredCopy[clanSource.id] = {};
	for (let key in config.filtered_data) {
		let guild = client.guilds.cache.get(config.filtered_data[key].guild_id);
		if (!guild) continue;
		let channel = guild.channels.cache.get(config.filtered_data[key].channel_id);
		if (channel instanceof TextChannel || channel instanceof NewsChannel) {
			filteredCopy[clanSource.id][key] = channel;
		}
	}
});

client.on(Events.MessageCreate, async message => {
	if (!message.guild || message.guild.id !== config.source_guild_id) return;
	if (simpleCopy[message.channelId]) {
		simpleCopy[message.channelId].send(message.content).catch(() => {
			console.log("Failed to send message to " + message.channelId);
		});
	}
	if (filteredCopy[message.channelId]) {
		for (let key in filteredCopy[message.channelId]) {
			if (message.content.includes("    " + key.toUpperCase() + " [")) {
				filteredCopy[message.channelId][key].send(message.content).catch(() => {
					console.log("Failed to send message to " + key);
				});
			}
		}
	}
	if (websocket && websocket.readyState === 1 && websocketTarget[message.channelId]) {
		websocket.send(JSON.stringify({
			typeId: message.channelId === config.clan_source ? 0 : message.channelId === config.solo_source ? 1 : 2,
			data: message.content
		}));
	}
});

client.login(config.token).then(() => console.log("Authenticated to Discord API!"));

let websocket: WebSocket|null;
websocket = null;

function websocketOpenHook() {
	console.log("Connected to websocket!");
	setTimeout(() => {
		websocket && websocket.send(JSON.stringify({type: "verification", secret: config.websocket_secret}));
	}, 1000);
}

let lastAttempt = 0;
function attemptConnect() {
	if (websocket && websocket.readyState === 1) return;
	if (Date.now() - lastAttempt < 5000) return;
	lastAttempt = Date.now();
	console.log("Attempting to connect to websocket...");
	try {
		websocket = new WebSocket(config.websocket_url);
		websocket.onopen = websocketOpenHook;
		websocket.onclose = () => setTimeout(attemptConnect, 5000);
		websocket.onerror = () => setTimeout(attemptConnect, 5000);
	} catch (e) {
		setTimeout(attemptConnect, 5000);
	}
}

attemptConnect();