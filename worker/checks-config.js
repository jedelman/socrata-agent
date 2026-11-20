// The check stage's settings from the Worker's environment (src/agent.js
// `checks`): CHECKS = "on" runs the code checks; SECOND_READ = "shadow" records
// and shows the second read's flags, "rewrite" also sends them back.
/** { secondRead } when CHECKS is "on", else null. */
export function answerChecks(env = {}) {
  if (String(env.CHECKS ?? '').trim().toLowerCase() !== 'on') return null;
  const mode = String(env.SECOND_READ ?? '').trim().toLowerCase();
  return { secondRead: ['shadow', 'rewrite'].includes(mode) ? mode : 'off' };
}
