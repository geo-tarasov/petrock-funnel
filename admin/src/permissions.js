// Роли админки. Читать может любой вошедший, менять — по списку прав.
export const PERMISSIONS = {
  owner: ['flow', 'media', 'settings', 'broadcast', 'botusers', 'accounts'],
  editor: ['flow', 'media', 'settings', 'broadcast', 'botusers'],
  marketer: ['media', 'broadcast'],
  viewer: [],
};

export const ROLE_TITLES = {
  owner: 'Владелец — всё, включая аккаунты',
  editor: 'Редактор — воронка, медиа, настройки, рассылки',
  marketer: 'Маркетолог — рассылки и медиа',
  viewer: 'Наблюдатель — только просмотр',
};

export const can = (role, permission) => (PERMISSIONS[role] || []).includes(permission);
