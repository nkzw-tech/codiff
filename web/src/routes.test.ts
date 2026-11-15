import { expect, expectTypeOf, test } from 'vite-plus/test';
import { routeUrl, type Href, type PageParams } from 'void/routes';

test('checks route names and params while encoding shared links', () => {
  expectTypeOf<'/stats'>().toExtend<Href>();
  expectTypeOf<'/statss'>().not.toExtend<Href>();
  expectTypeOf<string>().not.toExtend<Href>();
  expectTypeOf<PageParams<'/p/[slug]'>>().toEqualTypeOf<{ slug: string }>();
  expectTypeOf<PageParams<'/connect/[code]'>>().toEqualTypeOf<{ code: string }>();

  expect(routeUrl('/p/[slug]', { params: { slug: 'plan #1' } })).toBe('/p/plan%20%231');
  expect(routeUrl('/w/[slug]', { params: { slug: 'review/1' } })).toBe('/w/review%2F1');
});
