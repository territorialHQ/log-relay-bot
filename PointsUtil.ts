import {
	Client,
	Events,
	GatewayIntentBits,
	NewsChannel,
	Snowflake,
	TextChannel
} from "discord.js";
import {WebSocket} from "ws";
import * as mysql from "mysql2";
import {RowDataPacket} from "mysql2";

const config: {
	token: string,
	source_guild_id: Snowflake,
	clan_source: Snowflake,
	solo_source: Snowflake,
	zombie_source: Snowflake,
	primary_guild_id: Snowflake,
	clan_target: Snowflake,
	solo_target: Snowflake,
	zombie_target: Snowflake,
	filtered_data: { [key: string]: { guild_id: Snowflake, channel_id: Snowflake } },
	websocket_url: string[],
	websocket_secret: string,
	mysql_host: string,
	mysql_user: string,
	mysql_password: string,
	mysql_database: string
} = require("./config.json");

const client = new Client({intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]});
const db = mysql.createPool({
	host: config.mysql_host,
	user: config.mysql_user,
	password: config.mysql_password,
	database: config.mysql_database
});

let filteredCopy: { [key: Snowflake]: { [key: string]: TextChannel | NewsChannel } } = {};
let simpleCopy: { [key: Snowflake]: TextChannel | NewsChannel } = {};

let mapIds: { [key: number]: string } = {};
let mapNames: { [key: string]: number } = {};
let mysqlInitialized = false;
db.query<MapIdRow[]>("SELECT * FROM map_ids", (err, results) => {
	if (err) throw err;
	for (let row of results) {
		mapIds[row.id] = row.name;
		mapNames[row.name] = row.id;
	}
	mysqlInitialized = true;
});


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
		}
		let soloSource = a.channels.cache.get(config.solo_source);
		let soloTarget = b.channels.cache.get(config.solo_target);
		if (soloSource && (soloTarget instanceof TextChannel || soloTarget instanceof NewsChannel)) {
			simpleCopy[soloSource.id] = soloTarget;
		}
		let zombieSource = a.channels.cache.get(config.zombie_source);
		let zombieTarget = b.channels.cache.get(config.zombie_target);
		if (zombieSource && (zombieTarget instanceof TextChannel || zombieTarget instanceof NewsChannel)) {
			simpleCopy[zombieSource.id] = zombieTarget;
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
	for (let i = 0; i < config.websocket_url.length; i++) {
		let websocket = websockets[i];
		if (websocket && websocket.readyState === 1) {
			websocket.send(JSON.stringify({
				typeId: message.channelId === config.clan_source ? 0 : message.channelId === config.solo_source ? 1 : 2,
				data: message.content
			}));
		}
	}

	if (!mysqlInitialized || message.channelId !== config.clan_source) return;
	let match = message.content.match(/^(\*?\*?)([\w\s]+)\s{4}(\d+)\s{4}(.*)\s\[(\d+)\.(\d{3,4})->(\d+)\.(\d{3,4})](\*?\*?)$/);
	if (!match || match[1] !== match[9]) {
		console.log("Failed to parse message: " + message.content);
		return;
	}
	if (!mapNames[match[2]]) {
		db.query("INSERT INTO map_ids (name) VALUES (?)", [match[2]], (err) => {
			if (err) console.log(err);
		});
		mapNames[match[2]] = Object.keys(mapNames).length + 1;
		mapIds[mapNames[match[2]]] = match[2];
		console.log("Recognized new map: " + match[2]);
	}
	db.query("INSERT INTO clan_data (clan, points, is_contest, map, score_old, score_new, timestamp) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())", [
		match[4],
		parseInt(match[3]),
		match[1].length === 2,
		mapNames[match[2]],
		parseInt(match[5]) * 10000 + parseInt(match[6]) * (match[6].length === 3 ? 10 : 1),
		parseInt(match[7]) * 10000 + parseInt(match[8]) * (match[8].length === 3 ? 10 : 1)
	], (err) => {
		if (err) console.log(err);
	});
});

client.login(config.token).then(() => console.log("Authenticated to Discord API!"));

let websockets: (WebSocket | null)[] = [];

function websocketOpenHook(i: number) {
	console.log("Connected to websocket!");
	setTimeout(() => {
		let websocket = websockets[i];
		websocket && websocket.send(JSON.stringify({type: "verification", secret: config.websocket_secret}));
	}, 1000);
}

let lastAttempt: number[] = [];

function attemptConnect(i: number) {
	let websocket = websockets[i];
	if (websocket && websocket.readyState === 1) return;
	if (Date.now() - lastAttempt[i] < 5000) return;
	lastAttempt[i] = Date.now();
	try {
		let ws = new WebSocket(config.websocket_url[i]);
		websockets[i] = ws;
		ws.onopen = () => websocketOpenHook(i);
		ws.onclose = () => setTimeout(attemptConnect, 5000);
		ws.onerror = () => setTimeout(attemptConnect, 5000);
	} catch (e) {
		setTimeout(attemptConnect, 5000);
	}
}

for (let i = 0; i < config.websocket_url.length; i++) {
	websockets.push(null);
	lastAttempt.push(0);
	attemptConnect(i);
}


interface MapIdRow extends RowDataPacket {
	id: number,
	name: string
}