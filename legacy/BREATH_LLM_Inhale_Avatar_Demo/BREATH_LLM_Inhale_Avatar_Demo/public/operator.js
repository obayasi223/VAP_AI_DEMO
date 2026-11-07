const result = document.getElementById('result');
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    try {
      const response = await fetch('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, utterance: document.getElementById('phrase').value })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      result.textContent = `送信成功: ${action} (${new Date().toLocaleTimeString('ja-JP')})`;
    } catch (err) {
      result.textContent = `送信できませんでした: ${err.message}`;
    }
  });
}
