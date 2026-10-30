"""The static map pictures of the On-Duty journey report (geo_tracking/static_map.py): the zoom that fits a route, a picture made
from real tiles, and the grid fallback when no tile can be had. Nothing here uses the network: tiles are faked."""

import io
from unittest.mock import patch

from django.test import SimpleTestCase
from PIL import Image

from .geo_tracking import static_map as sm

ROUTE = [(11.1085, 77.3411), (11.1100, 77.3450), (11.1120, 77.3480)]


def _tile(color=(200, 220, 200)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (256, 256), color).save(out, format="PNG")
    return out.getvalue()


class StaticMapTests(SimpleTestCase):
    def setUp(self):
        sm._cache.clear()

    def test_the_zoom_is_the_largest_at_which_the_route_fits(self):
        near = sm.fit_zoom([(11.1085, 77.3411), (11.1086, 77.3412)], 900, 500, 50)
        far = sm.fit_zoom([(11.0, 77.0), (11.5, 77.9)], 900, 500, 50)
        self.assertEqual(near, sm.MAX_ZOOM)
        self.assertLess(far, near)
        # at that zoom every point is inside the picture
        xs, ys = zip(*(sm.world_xy(lat, lng, far) for lat, lng in [(11.0, 77.0), (11.5, 77.9)]))
        self.assertLessEqual(max(xs) - min(xs), 900)
        self.assertLessEqual(max(ys) - min(ys), 500)

    def test_a_picture_is_made_from_tiles_with_the_route_and_markers_drawn_on_it(self):
        markers = [sm.Marker(*ROUTE[0], "S", sm.START_COLOR, 20, tag="START"), sm.Marker(*ROUTE[1], "1")]
        with patch.object(sm, "_fetch", return_value=_tile()):
            data, has_tiles = sm.render(ROUTE, markers, 600, 360, sm.MapBudget())
        self.assertTrue(has_tiles)
        image = Image.open(io.BytesIO(data))
        self.assertEqual((image.format, image.size), ("JPEG", (600, 360)))
        pixels = list(image.getdata())
        # the route's blue and the green start marker are in the picture
        self.assertTrue(any(b > 180 and r < 90 and g < 140 for r, g, b in pixels))
        self.assertTrue(any(g > 140 and r < 60 and b < 100 for r, g, b in pixels))

    def test_without_tiles_the_route_is_still_drawn_on_a_grid_and_it_says_so(self):
        with patch.object(sm, "_fetch", return_value=None):
            data, has_tiles = sm.render(ROUTE, [sm.Marker(*ROUTE[0], "1")], 600, 360, sm.MapBudget())
        self.assertFalse(has_tiles)
        self.assertEqual(Image.open(io.BytesIO(data)).size, (600, 360))

    def test_a_tile_server_that_never_answers_is_given_up_on(self):
        budget = sm.MapBudget()
        with patch.object(sm.urllib.request, "urlopen", side_effect=OSError("no internet")):
            for x in range(6):
                self.assertIsNone(sm._fetch(15, 100 + x, 100, budget))
        self.assertTrue(budget.spent)

    def test_a_tile_is_fetched_once_and_kept_for_the_next_report(self):
        class Reply:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return _tile()

        budget = sm.MapBudget()
        with patch.object(sm.urllib.request, "urlopen", return_value=Reply()) as opened:
            self.assertIsNotNone(sm._fetch(15, 1, 2, budget))
            self.assertIsNotNone(sm._fetch(15, 1, 2, budget))
        self.assertEqual(opened.call_count, 1)

    def test_a_route_of_thousands_of_points_is_thinned_but_keeps_its_ends(self):
        points = [(11.0 + i * 1e-5, 77.0) for i in range(10_000)]
        thinned = sm._thin(points)
        self.assertLessEqual(len(thinned), 1800)
        self.assertEqual((thinned[0], thinned[-1]), (points[0], points[-1]))
