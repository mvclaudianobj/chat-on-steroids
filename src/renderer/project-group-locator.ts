/**
 * Match project identity as data, not as a CSS selector.
 *
 * Project IDs are opaque (and can contain quotes, backslashes, and selector
 * metacharacters). CSS.escape is not available in all embedded/test renderers,
 * and interpolating an unescaped ID in a selector could match another project.
 */
export function findProjectGroup(
  document: Pick<Document, 'querySelectorAll'>,
  projectId: string
): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('.project-group[data-project-id]')) {
    if (element.dataset.projectId === projectId) return element;
  }
  return null;
}
