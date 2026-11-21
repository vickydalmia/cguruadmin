/**
 * Fills {{placeholders}} in a prompt template. Strict both ways: a missing
 * value and a value the template never uses both throw, so a template edit
 * that drops or renames a placeholder fails in tests, not in production.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const output = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`Prompt placeholder {{${name}}} has no value.`);
    used.add(name);
    return values[name];
  });
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length) throw new Error(`Prompt values not used by the template: ${unused.join(', ')}.`);
  return output;
}
