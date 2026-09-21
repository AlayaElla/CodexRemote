// HID acknowledges transport delivery; the Mac runtime has a distinct receipt.
function controlDelivered(result) {
  return result?.delivery === 'submitted_to_hid' ||
    (result?.delivery === 'desktop_runtime' && ['requested', 'confirmed'].includes(result.outcome));
}
module.exports = { controlDelivered };
