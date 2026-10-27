/** Management command: `npm run sponsors:remind` (cron-friendly). Sends due sponsor follow-up reminders once and exits. */
import mongoose from 'mongoose';
import { env } from './config/env';
import { sendFollowUpReminders } from './services/sponsorReminders';

async function main() {
  await mongoose.connect(env.mongoUri);
  const r = await sendFollowUpReminders();
  console.log(`Sponsor reminders: ${r.sent} sent, ${r.checked} due sponsor(s) checked.`);
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
