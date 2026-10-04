import express from 'express';
import { parseSwapEvent } from './parser';
import { enqueue } from './queue';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.send({ ok: true, service: 'skim-listener' }));

// Helius / QuickNode / Shyft POST confirmed tx batches here.
app.post('/webhook/tx', async (req, res) => {
  try {
    const events = req.body;
    if (!Array.isArray(events)) {
      res.status(400).send('expected array');
      return;
    }
    let queued = 0;
    for (const e of events) {
      const s = parseSwapEvent(e);
      if (s && s.ok) {
        await enqueue({
          user: s.user,
          tokenMint: s.outputMint,
          outputAmount: s.outputAmount.toString(),
          signature: s.signature,
        });
        queued++;
      }
    }
    res.send({ queued });
  } catch (e: any) {
    res.status(500).send({ error: e.message });
  }
});

const port = Number(process.env.WEBHOOK_PORT ?? 4000);
if (require.main === module) {
  app.listen(port, () => console.log(`skim-listener on ${port}`));
}
export default app;
