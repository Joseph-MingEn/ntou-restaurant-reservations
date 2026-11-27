export const VENUE_NAME = '台北 101';
export const VENUE_ADDRESS = '台北市信義區信義路五段7號';
export const VENUE_MAP_URL = 'https://www.google.com/maps/search/?api=1&query='
  + encodeURIComponent(VENUE_NAME + ' ' + VENUE_ADDRESS);
export const VENUE_DETAILS = ['用餐地點', VENUE_NAME, VENUE_ADDRESS, VENUE_MAP_URL].join('\n');
