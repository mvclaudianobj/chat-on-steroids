import { describe, expect, it } from 'vitest';
import { promisesImmediateNextStep } from '../src/shared/next-step-continue.js';

describe('terminal promise of immediate work', () => {
  it.each([
    'Vou reproduzir o erro e corrigir.',
    'Relatório parcial.\n\nAgora vou executar os testes e corrigir o que falhar.',
    'Next, I will reproduce the failure and run the suite.',
    'I’ll test the app and fix any regressions.'
  ])('admits a concrete next action: %s', text => {
    expect(promisesImmediateNextStep(text)).toBe(true);
  });
  it.each([
    'A correção terminou e os testes passaram.',
    'Posso reproduzir a falha se quiser.',
    'Vou reproduzir a falha se você autorizar.',
    'Você quer que eu teste?',
    'A mensagem diz: "vou reproduzir a falha".',
    'Aqui está o plano:\n\n- Vou testar a função.',
    'Vamos testar um exemplo?' 
  ])('does not turn advice, quotes or completed work into a send: %s', text => {
    expect(promisesImmediateNextStep(text)).toBe(false);
  });
});
