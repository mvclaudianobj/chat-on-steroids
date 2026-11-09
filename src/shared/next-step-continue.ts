/** A terminal answer can still explicitly promise to perform work next.
 * This is a narrow admission signal, never evidence that work was completed.
 * The outbox additionally requires exact current-turn MCP work and an idle chat.
 */
export function promisesImmediateNextStep(text: string): boolean {
  const paragraph = text.trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
  if (!paragraph || paragraph.length > 600 || /^\s*(?:>|```|[-*]\s)/.test(paragraph) || /[?]\s*$/.test(paragraph)) return false;
  const line = paragraph.replace(/\*\*/g, '').replace(/^#{1,4}\s+/, '').replace(/\s+/g, ' ').trim();
  if (/\b(?:se quiser|se você quiser|se autorizar|se você autorizar|quando autorizar|if you want|if you approve|once you approve)\b/i.test(line)) return false;
  return /^(?:(?:agora|em seguida|a seguir|na sequ[eê]ncia|primeiro|pr[oó]ximo passo|next|next step|now|then)[,:\s-]+)?(?:eu\s+)?(?:vou|irei|vamos|farei|seguirei|continuarei|preciso|i(?:'|’)ll|i will|we(?:'|’)ll|we will)\s+(?:(?:agora|ent[aã]o|em seguida|to|a|de|com)\s+)?(?:reproduzir|testar|executar|rodar|investigar|verificar|validar|corrigir|implementar|ajustar|integrar|continuar|prosseguir|revisar|analisar|aplicar|conferir|tentar|reproduce|test|run|investigate|verify|validate|fix|implement|patch|integrate|continue|check|review|apply|debug)\b/i.test(line);
}
