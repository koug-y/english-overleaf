import http from 'node:http';
import { handle } from '../src/app.js';

const port = Number(process.env.PORT || 8787);
http.createServer(handle).listen(port, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${port}`));
