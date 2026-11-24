import { handle } from '../src/app.js';

export const config = { maxDuration: 60 };

export default function handler(req, res) {
  return handle(req, res);
}
