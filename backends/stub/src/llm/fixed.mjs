// Fixed-reply LLM — always returns the same canned text regardless
// of input. For the barge smoke rig: the audio-bridge runs with
// `provider: fixture` and replays a pre-recorded WAV; the agent text
// has to match the WAV so the listener perceives a coherent
// "agent counted from 1 to 10" turn. Not useful in production.
//
// Selected via AGENT_LLM=fixed; reply text comes from
// AGENT_LLM_FIXED_REPLY (defaults to "1, 2, 3, 4, 5, 6, 7, 8, 9, 10.").

export class FixedLLM {
  name = 'fixed';

  /** @param {{ reply?: string }} opts */
  constructor({ reply } = {}) {
    this.reply = reply || '1, 2, 3, 4, 5, 6, 7, 8, 9, 10.';
  }

  /**
   * @param {Array<{role: string, content: string}>} _messages
   */
  async *stream(_messages) {
    yield this.reply;
  }
}
