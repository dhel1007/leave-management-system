import { openDatabase } from './db.js';
import { createApp } from './app.js';
const db = openDatabase(process.env.DB_PATH);
const port = Number(process.env.PORT || 3001);
const server = createApp(db).listen(port, '127.0.0.1', () => console.log('Agency Leave is running locally at http://127.0.0.1:' + port));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
