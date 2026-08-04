// @ts-check

/** @param {unknown} response */
const parseOverviewResponse = (response) => {
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || text).trim();
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Walkthrough overview response is not valid JSON: ${detail}`);
  }
  if (!value || typeof value !== 'object' || typeof value.focus !== 'string') {
    throw new Error('Walkthrough overview response must contain a focus string.');
  }
  const focus = value.focus.trim();
  if (!focus) {
    throw new Error('Walkthrough overview response must contain a non-empty focus string.');
  }
  return { focus };
};

module.exports = { parseOverviewResponse };
