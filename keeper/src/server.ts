import express from 'express';

const app = express();
app.use(express.json());

// Health only — real webhook lives in listener/. Keeper exposes manual trigger.
app.get('/health', (_req, res) => res.send({ ok: true, service: 'skim-keeper' }));

const port = Number(process.env.KEEPER_PORT ?? 5001);
if (require.main === module) {
  app.listen(port, () => console.log(`skim-keeper on ${port}`));
}
export default app;
