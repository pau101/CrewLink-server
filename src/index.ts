import express from 'express';
import { Server } from 'http';
import socketIO from 'socket.io';
import Tracer from 'tracer';
import morgan from 'morgan';

const port = parseInt(process.env.PORT || '9736');

const logger = Tracer.colorConsole({
	format: '{{timestamp}} <{{title}}> {{message}}'
});

const app = express();
const server = new Server(app);
const io = socketIO(server);

const playerIds = new Map<string, number>();

interface Signal {
	data: string;
	to: string;
}

let connectionCount = 0;

app.use(morgan('combined'));
app.use(express.static('offsets'));
app.use('/', (_, res) => {
	const rooms = Object.keys(io.sockets.adapter.rooms).length - connectionCount;
	res.status(200).send(`
		<!doctype html>
		<html>
		<head><title>CrewLink+ Relay Server</title></head>
		<body>
		<p>Currently ${rooms} open room${rooms !== 1 ? 's' : ''} and ${connectionCount} online player${connectionCount !== 1 ? 's' : ''}.</p>
		</body>
		</html>
	`);
});

io.on('connection', (socket: socketIO.Socket) => {
	connectionCount++;
	logger.info("Total connected: %d", connectionCount);
	let code: string | null = null;

	function leave() {
		if (!code) return;
		const id = playerIds.get(socket.id);
		if (typeof id !== 'number') return;
		socket.to(code).broadcast.emit('deleteId', socket.id);
		socket.leave(code);
		logger.info('Leave room %s: %s', code, socket.id);
		code = null;
	}

	socket.on('join', (c: string, id: number) => {
		if (typeof c !== 'string' || typeof id !== 'number') {
			socket.disconnect();
			logger.error('Socket %s sent invalid join command: %s %d', socket.id, c, id);
			return;
		}
		leave();
		code = c;
		socket.join(code);
		playerIds.set(socket.id, id);
		socket.to(code).broadcast.emit('join', socket.id, id);
		logger.info('Join broadcast in room %s: %s %s', code, socket.id, id);
		let socketsInLobby = Object.keys(io.sockets.adapter.rooms[code].sockets);
		let ids: any = {};
		for (let s of socketsInLobby) {
			if (s !== socket.id) {
				ids[s] = playerIds.get(s);
			}
		}
		socket.emit('setIds', ids);
		logger.info('Join reply in room %s: %s %j', code, socket.id, ids);
	});

	socket.on('id', (id: number) => {
		if (typeof id !== 'number') {
			socket.disconnect();
			logger.error('Socket %s sent invalid id command: %d', socket.id, id);
			return;
		}
		if (code) {
			playerIds.set(socket.id, id);
			socket.to(code).broadcast.emit('setId', socket.id, id);
			logger.info('ID broadcast to room %s: %s %s', code, socket.id, id);
		}
	});

	socket.on('leave', () => leave());

	socket.on('signal', (signal: Signal) => {
		if (typeof signal !== 'object' || !signal.data || !signal.to || typeof signal.to !== 'string') {
			socket.disconnect();
			logger.error('Socket %s sent invalid signal command: %j', socket.id, signal);
			return;
		}
		const { to, data } = signal;
		io.to(to).emit('signal', {
			data,
			from: socket.id
		});
	});

	socket.on('disconnecting', () => {
		const id = playerIds.get(socket.id);
		if (typeof id !== 'number') return;
		for (const room of Object.keys(socket.rooms)) {
			if (room !== socket.id) {
				socket.to(room).broadcast.emit('deleteId', socket.id, id);
				logger.info('Leave room %s: %s', room, socket.id);
			}
		}
	});

	socket.on('disconnect', () => {
		connectionCount--;
		logger.info('Total connected: %d', connectionCount);
		playerIds.delete(socket.id);
	});

});

server.listen(port);
logger.info('Server listening on port %d', port);