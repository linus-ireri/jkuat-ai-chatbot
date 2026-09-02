/** Strip Qwen/Groq thinking blocks so users only see the final answer. */
export function cleanLlmAnswer(text) {
  if (!text) return text;
  return String(text)
    .replace(/<(?:redacted_)?think(?:ing)?>[\s\S]*?<\/(?:redacted_)?think(?:ing)?>/gi, "")
    .trim();
}
