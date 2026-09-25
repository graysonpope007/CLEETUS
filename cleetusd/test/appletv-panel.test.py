import importlib.util
import pathlib
import types
import unittest
from unittest.mock import AsyncMock
from pyatv.const import FeatureState, PowerState, KeyboardFocusState

spec=importlib.util.spec_from_file_location('panel',pathlib.Path(__file__).parents[1]/'bin/appletv-panel.py')
panel=importlib.util.module_from_spec(spec);spec.loader.exec_module(panel)

class TVTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        rc=types.SimpleNamespace(home=AsyncMock(),play=AsyncMock())
        features=types.SimpleNamespace(get_feature=lambda name:types.SimpleNamespace(state=FeatureState.Available))
        playing=types.SimpleNamespace(device_state=types.SimpleNamespace(),title='Test title',artist=None,album=None,position=0,total_time=60,shuffle=None,repeat=None)
        panel.atv=types.SimpleNamespace(remote_control=rc,features=features,metadata=types.SimpleNamespace(playing=AsyncMock(return_value=playing),app=types.SimpleNamespace(name='TV',identifier='com.apple.TVWatchList')),device_info=types.SimpleNamespace(model='AppleTV',version='26.6'),power=types.SimpleNamespace(power_state=PowerState.On),audio=types.SimpleNamespace(volume=20),keyboard=types.SimpleNamespace(text_focus_state=KeyboardFocusState.Unfocused,text_set=AsyncMock()))
        self.rc=rc
    async def test_wake_uses_verified_double_home(self):
        result=await panel.command('wake',{})
        self.assertTrue(result['accepted']);self.assertEqual(self.rc.home.await_count,2)
    async def test_unavailable_action_never_sends(self):
        panel.atv.features.get_feature=lambda name:types.SimpleNamespace(state=FeatureState.Unavailable)
        with self.assertRaises(ValueError):await panel.command('play',{})
        self.rc.play.assert_not_awaited()
    async def test_keyboard_requires_focused_field(self):
        with self.assertRaises(ValueError):await panel.command('text_set',{'value':'test'})
        panel.atv.keyboard.text_set.assert_not_awaited()
    async def test_snapshot_keeps_app_name_and_identifier(self):
        state=await panel.state();self.assertEqual(state['app'],{'name':'TV','id':'com.apple.TVWatchList'});self.assertEqual(state['power'],'On')

if __name__=='__main__':unittest.main()
