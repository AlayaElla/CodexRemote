// Self-contained: serialized into the Codex renderer by the realtime adapter.
function findRealtimeControls(document, label) {
  const labels = {
    'Start voice chat': ['Start voice chat', '开始语音聊天', '开启语音聊天', '開始語音對話'],
    'Mute microphone': ['Mute microphone', '将麦克风静音', '將麥克風靜音'],
    'Unmute microphone': ['Unmute microphone', '取消麦克风静音', '取消麥克風靜音', '將麥克風取消靜音'],
    'Stop voice chat': ['Stop voice chat', '结束语音聊天', '停止语音聊天', '結束語音對話', '停止語音對話'],
    'Cancel voice chat': ['Cancel voice chat', '取消语音聊天', '取消語音對話', '取消啟動語音對話']
  };
  const accepted = labels[label] || [label];
  return [...document.querySelectorAll('button[aria-label]')].filter(node =>
    accepted.includes(node.getAttribute('aria-label')) && !node.disabled &&
    node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length > 0);
}

module.exports = findRealtimeControls;
