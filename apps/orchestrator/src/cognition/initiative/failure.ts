/** 例外から判定の失敗の理由を作る。GeminiProviderError は kind を持つ。キーはプロバイダ側で伏せてある。 */
export function failureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'kind' in error && typeof (error as { kind: unknown }).kind === 'string') {
    const message = error instanceof Error ? error.message : '';
    return `provider_error:${(error as { kind: string }).kind}:${message.slice(0, 160)}`;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `provider_error:${message.slice(0, 160)}`;
}
