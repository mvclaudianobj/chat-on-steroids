import { t } from './i18n.js';

/**
 * A small in-app form for the few questions that used `window.prompt`: Electron does not implement
 * it (it returns at once with nothing), so those menu actions silently did nothing. Each field is a
 * text input, or a select when it lists choices. Resolves the trimmed answers, or null on Cancel.
 */
export interface AskField {
  label: string;
  value?: string;
  choices?: { value: string; label: string }[];
  placeholder?: string;
  type?: 'text' | 'password' | 'checkbox';
  optional?: boolean;
}

export function askFields(title: string, fields: AskField[], submit: string = t('OK')): Promise<string[] | null> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'plugin-dialog';
    const head = document.createElement('div');
    head.className = 'plugin-dialog-head';
    const heading = document.createElement('h2');
    heading.textContent = title;
    head.append(heading);
    const form = document.createElement('form');
    form.className = 'plugin-dialog-body';
    const inputs = fields.map(field => {
      const label = document.createElement('label');
      label.className = 'plugin-field';
      const caption = document.createElement('span');
      caption.textContent = field.label;
      let input: HTMLInputElement | HTMLSelectElement;
      if (field.choices) {
        const select = document.createElement('select');
        for (const choice of field.choices) select.append(new Option(choice.label, choice.value, false, choice.value === field.value));
        input = select;
      } else {
        const text = document.createElement('input');
        text.type = field.type ?? 'text';
        text.spellcheck = false;
        if (field.type === 'checkbox') text.checked = field.value === 'true';
        else text.value = field.value ?? '';
        if (field.placeholder) text.placeholder = field.placeholder;
        input = text;
      }
      input.required = !field.optional && field.type !== 'checkbox';
      label.append(caption, input);
      form.append(label);
      return input;
    });
    const actions = document.createElement('div');
    actions.className = 'pet-delete-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = t('Cancel');
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'btn btn-solid';
    ok.textContent = submit;
    actions.append(cancel, ok);
    form.append(actions);
    dialog.append(head, form);
    let answer: string[] | null = null;
    const close = () => { if (dialog.open) dialog.close(); };
    cancel.addEventListener('click', close);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const values = inputs.map(input => input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value.trim());
      if (values.some((value, index) => !fields[index]?.optional && fields[index]?.type !== 'checkbox' && !value)) return;
      answer = values;
      close();
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); });
    document.body.append(dialog);
    dialog.showModal();
    inputs[0]?.focus();
  });
}
