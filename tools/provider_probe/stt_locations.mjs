// Lists ja-JP models and features from the locations API. This call is not billed as recognition.
import { parseArgs } from 'node:util';
import { requireGoogleStt, fail, redact } from './lib/common.mjs';
import { makeClient } from './lib/stt.mjs';

const { values: args } = parseArgs({
  options: {
    locations: { type: 'string', default: 'us,eu,global,asia-southeast1,asia-northeast1,us-central1' },
    language: { type: 'string', default: 'ja-JP' },
  },
});
requireGoogleStt();

const project = process.env.GOOGLE_CLOUD_PROJECT;
try {
  for (const location of args.locations.split(',')) {
    const client = await makeClient(location);
    try {
      const [loc] = await client.getLocation({ name: `projects/${project}/locations/${location}` });
      const { protos } = await import('@google-cloud/speech');
      const meta = protos.google.cloud.speech.v2.LocationsMetadata.decode(loc.metadata.value);
      // Hierarchy per locations_metadata.proto: locale -> model -> features.
      const locales = meta.languages?.models ?? {};
      const key = Object.keys(locales).find((k) => k.toLowerCase() === args.language.toLowerCase());
      const models = key ? locales[key].modelFeatures ?? {} : {};
      console.log(`\n[${location}] ${args.language}: ${Object.keys(models).join(', ') || '(なし)'}`);
      for (const [model, features] of Object.entries(models)) {
        const list = (features.modelFeature ?? []).map((f) => `${f.feature}(${f.releaseState})`);
        console.log(`  ${model}: ${list.join(', ')}`);
      }
    } catch (err) {
      console.log(`\n[${location}] 取得失敗: ${redact(err.message)}`);
    } finally {
      await client.close();
    }
  }
} catch (err) {
  fail(err);
}
