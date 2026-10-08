// weather — icon/condition mapping, labels, requesting a location, rendering a report.
import { expect, it } from 'vitest';
import weather, { compass, condition, hourLabel, timeLabel } from '../widgets/weather/widget.ts';
// @ts-expect-error plain JS module (the source driver)
import { scorePlace } from '../sources/weather/weather.mjs';
import { hasIcon } from '../shared/icons.ts';
import { mount } from './harness.ts';

it('maps every WMO weather code to a label and an existing Lucide icon', () => {
  for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
    for (const day of [true, false]) {
      const [label, icon] = condition(code, day);
      expect(label).not.toBe('—');
      expect(hasIcon(icon)).toBe(true);
    }
  }
  expect(condition(0, false)[1]).toBe('moon');
  expect(condition(63)[0]).toBe('Rain');
});

it('formats labels', () => {
  expect(compass(222)).toBe('SW');
  expect(compass(-10)).toBe('N');
  expect(hourLabel('2026-10-08T00:00')).toBe('12 AM');
  expect(hourLabel('2026-10-08T16:00')).toBe('4 PM');
  expect(timeLabel('2026-10-08T18:35')).toBe('6:35 PM');
});

it('the source picks between same-named places by region / country / initials', () => {
  const bc = { admin1: 'British Columbia', country: 'Canada', country_code: 'CA' };
  const co = { admin1: 'Colorado', country: 'United States', country_code: 'US' };
  expect(scorePlace(bc, ['BC', 'Canada'])).toBeGreaterThan(scorePlace(co, ['BC', 'Canada']));
  expect(scorePlace(co, ['Colorado'])).toBeGreaterThan(scorePlace(bc, ['Colorado']));
  expect(scorePlace(co, ['US'])).toBeGreaterThan(0);
});

const report = {
  status: 'ready',
  place: { name: 'Delta', admin1: 'British Columbia', country: 'Canada', utcOffset: -25200 },
  units: { temp: '°C', wind: 'km/h' },
  current: { temp: 17.2, feels: 17.8, humidity: 81, code: 0, wind: 4.7, windDir: 222, isDay: true, time: '2026-10-08T15:15' },
  hourly: Array.from({ length: 12 }, (_, i) => ({ time: `2026-10-08T${String(16 + i).padStart(2, '0').replace('24', '00')}:00`, temp: 16 - i * 0.5, code: i < 4 ? 3 : 61, pop: 10 * i, isDay: i < 3 })),
  daily: Array.from({ length: 6 }, (_, i) => ({ date: `2026-10-${String(8 + i).padStart(2, '0')}`, code: [45, 53, 3, 0, 2, 61][i], max: 17 - i, min: 8 - i, pop: [1, 82, 10, 0, 5, 60][i], sunrise: `2026-10-${String(8 + i).padStart(2, '0')}T07:22`, sunset: `2026-10-${String(8 + i).padStart(2, '0')}T18:35` })),
  updatedAt: Date.now(),
};

it('requests its location and renders the report', async () => {
  const h = await mount(weather, { location: 'Delta, BC, Canada' });
  expect(h.rec.published.at(-1)).toMatchObject({ channel: 'weather.request', value: { location: 'Delta, BC, Canada', units: 'metric' } });
  h.frame();
  expect(h.hasText('Loading weather…')).toBe(true);
  h.publish('weather.data', { 'Delta, BC, Canada|metric': report, 'Paris|metric': { status: 'loading' } });
  h.frame();
  for (const t of ['Delta', 'British Columbia, Canada', '17°', 'Clear', 'Feels like 18°', 'H 17°  ·  L 8°', '5 km/h SW', '81%', '6:35 PM', 'Today', 'Fri', '82%']) {
    expect(h.hasText(t), t).toBe(true);
  }
  expect(h.hasText('Loading weather…')).toBe(false);
  expect(h.root.getObjectByName('icon:sun')).toBeTruthy();
  expect(h.root.getObjectByName('icon:cloud-drizzle')).toBeTruthy(); // Friday

  await h.setProps({ location: 'Paris', units: 'imperial' });
  expect(h.rec.published.at(-1)).toMatchObject({ channel: 'weather.request', value: { location: 'Paris', units: 'imperial' } });
  h.publish('weather.data', { 'Paris|imperial': { status: 'error', error: 'no place called "Pariss"' } });
  h.frame();
  expect(h.hasText(`Couldn't load: no place called "Pariss"`)).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
