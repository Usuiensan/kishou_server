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

function filterLegacyApiResponse(notifications) {
  return Array.isArray(notifications)
    ? notifications.filter((notification) => !['earthquake_1', 'earthquake_2', 'earthquake_3'].includes(notification?.type))
    : notifications;
}

function isUnityNotification(notification) {
  if (!notification || typeof notification !== 'object') return false;
  if (notification.type === 'eew') return true;
  if (['earthquake_4', 'earthquake_5l', 'earthquake_5h', 'earthquake_6l', 'earthquake_6h', 'earthquake_7'].includes(notification.type)) return true;
  const categories = notification.nervCategories || (notification.nervCategory ? [`nerv_${notification.nervCategory}`] : []);
  return notification.source === 'nerv' && categories.some((category) => category === 'nerv_level5' || category === 'nerv_news');
}

function toUnityApiResponse(notifications) {
  return Array.isArray(notifications) ? notifications.filter(isUnityNotification) : notifications;
}

module.exports = {
  toLegacyApiType,
  toLegacyApiNotification,
  toLegacyApiResponse,
  filterLegacyApiResponse,
  isUnityNotification,
  toUnityApiResponse,
};
