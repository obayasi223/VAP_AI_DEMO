import { describe, expect, it } from 'vitest';
import { AVATAR_MODELS, DEFAULT_AVATAR_ID, avatarRecord, resolveAvatarChoice } from '../avatar_models';

describe('resolveAvatarChoice', () => {
  it('指定が無ければ既定の VRM', () => {
    const choice = resolveAvatarChoice({});
    expect(choice.id).toBe('vrm');
    expect(DEFAULT_AVATAR_ID).toBe('vrm');
    expect(choice.source).toBe('default');
    expect(choice.spec?.kind).toBe('vrm');
  });

  it('?avatar= はオプトイン。環境変数より強い', () => {
    expect(resolveAvatarChoice({ avatarQuery: 'rocketbox', env: 'vrm' }).id).toBe('rocketbox');
    expect(resolveAvatarChoice({ env: 'rocketbox' })).toMatchObject({ id: 'rocketbox', source: 'env' });
  });

  it('?model=（従来の URL 指定）は VRM として最優先', () => {
    const choice = resolveAvatarChoice({ modelQuery: '/models/x.vrm', avatarQuery: 'rocketbox' });
    expect(choice).toMatchObject({ id: 'vrm', url: '/models/x.vrm', source: 'model_query' });
  });

  it('知らない id は既定へ戻して rejected に残す（刺激が黙って変わらない）', () => {
    const choice = resolveAvatarChoice({ avatarQuery: 'rocketboxx' });
    expect(choice).toMatchObject({ id: 'vrm', source: 'default', rejected: 'rocketboxx' });
  });

  it('none は描画なし（測定用）', () => {
    expect(resolveAvatarChoice({ avatarQuery: 'none' })).toMatchObject({ id: 'none', spec: null, url: null });
  });
});

describe('avatarRecord', () => {
  it('読み込みの結果を manifest の形にする', () => {
    const record = avatarRecord(resolveAvatarChoice({ avatarQuery: 'rocketbox' }), 'failed', 'boom');
    expect(record).toEqual({
      avatar_id: 'rocketbox',
      kind: 'glb',
      model_url: AVATAR_MODELS.rocketbox.url,
      source: 'query',
      status: 'failed',
      error: 'boom',
    });
  });
});
