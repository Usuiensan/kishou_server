const LOW_INTENSITY_TYPES = new Set([
  'earthquake_1',
  'earthquake_2',
  'earthquake_3',
  'earthquake_4',
]);

const EMERGENCY_TYPES = new Set([
  'eew',
  'earthquake',
  'earthquake_5l',
  'earthquake_5h',
  'earthquake_6l',
  'earthquake_6h',
  'earthquake_7',
  'tsunami_warning',
  'tsunami_advisory',
  'nerv',
  'weather',
]);

function toLegacyApiType(type) {
  if (LOW_INTENSITY_TYPES.has(type) || type === 'stable') return type;
  if (EMERGENCY_TYPES.has(type)) return 'emergency';
  return type;
}

function toLegacyApiNotification(notification) {
  if (!notification || typeof notification !== 'object') return notification;
  return { ...notification, type: toLegacyApiType(notification.type) };
}

function toLegacyApiResponse(notifications) {
  return Array.isArray(notifications) ? notifications.map(toLegacyApiNotification) : notifications;
}

module.exports = {
  toLegacyApiType,
  toLegacyApiNotification,
  toLegacyApiResponse,
};
