/** Strip Qwen/Groq thinking blocks and noisy evidence boilerplate so users only see the final answer. */
export function cleanLlmAnswer(text) {
  if (!text) return text;

  let cleaned = String(text)
    .replace(/<(?:redacted_)?think(?:ing)?>[\s\S]*?<\/(?:redacted_)?think(?:ing)?>/gi, '')
    .replace(/\*\*?\s*\(?(?:see\s+)?Evidence\s*#?\d+(?:\s*(?:and|or|,)?\s*#?\d+)*[^\n]*\)?\*\*?/gi, '')
    .replace(/\(\s*see\s+Evidence\s*#?\d+(?:\s*(?:and|or|,)?\s*#?\d+)*[^\n]*\)/gi, '')
    .replace(/\b(?:see\s+)?Evidence\s*#\d+(?:\s*(?:and|or|,)?\s*#?\d+)*\b/gi, '')
    .replace(/\*\*\s*(?:Events listed for the current semester|Regular Academic-?Semester Deadlines).*?\*\*/gi, '')
    .replace(/\*\*\*+/g, '**')
    .replace(/\*\*\s*\|/g, '|')
    .replace(/\|\s*\*\*/g, '| ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return cleaned;

  return cleaned
    .replace(/^\s*[-*]\s*\*\*\s*/gm, '- ')
    .replace(/\n\s*\|\s*Date\s*\|\s*Time\s*\|/gi, '\n\n| Date | Time |')
    .replace(/\n{2,}\|/g, '\n\n|')
    .trim();
}
