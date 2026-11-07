// Reports which credentials are set, as yes/no only. Makes no network call.
const major = Number(process.versions.node.split('.')[0]);
const rows = [
  ['GOOGLE_CLOUD_PROJECT', Boolean(process.env.GOOGLE_CLOUD_PROJECT)],
  ['GOOGLE_APPLICATION_CREDENTIALS または GOOGLE_STT_USE_ADC=1', Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) || process.env.GOOGLE_STT_USE_ADC === '1'],
  ['GEMINI_API_KEY', Boolean(process.env.GEMINI_API_KEY)],
  ['ELEVENLABS_API_KEY', Boolean(process.env.ELEVENLABS_API_KEY)],
  ['ELEVENLABS_VOICE_ID', Boolean(process.env.ELEVENLABS_VOICE_ID)],
];
for (const [name, ok] of rows) console.log(`${ok ? '設定済み' : '未設定  '}  ${name}`);
console.log(`Node ${process.versions.node}${major >= 22 ? '' : '（@google-cloud/speech 8 は Node 22 以上が必要）'}`);
