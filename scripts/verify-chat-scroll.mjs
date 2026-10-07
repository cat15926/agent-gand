import assert from 'node:assert/strict';
import { ChatScrollController } from '../apps/web/src/chatScroll.ts';

const controller = new ChatScrollController();
const surface = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };

controller.sync('room-a', surface); // 切换后先渲染空消息
surface.scrollHeight = 3_000; // 历史消息异步回填
controller.sync('room-a', surface);
assert.equal(surface.scrollTop, 3_000, '进入房间后应定位到最新消息');

surface.scrollTop = 100;
controller.onScroll(surface); // 用户主动向上翻阅
surface.scrollHeight = 3_500;
controller.sync('room-a', surface);
assert.equal(surface.scrollTop, 100, '同房间收到新消息不能打断向上翻阅');

surface.scrollTop = 3_450;
controller.onScroll(surface); // 用户回到底部附近
surface.scrollHeight = 3_800;
controller.sync('room-a', surface);
assert.equal(surface.scrollTop, 3_800, '回到底部后应继续跟随新消息');

surface.scrollTop = 100;
controller.onScroll(surface);
surface.scrollTop = 0;
surface.scrollHeight = 100;
controller.sync('room-b', surface); // 再次切换，消息先清空
surface.scrollHeight = 5_000;
controller.sync('room-b', surface); // 异步加载历史
assert.equal(surface.scrollTop, 5_000, '再次切换房间也应定位到最新消息');

controller.sync(null, null);
surface.scrollTop = 0;
controller.sync('room-a', surface);
assert.equal(surface.scrollTop, 5_000, '离开聊天视图后重进也应定位到最新消息');

// A refresh waits for history to arrive before restoring a saved read position.
const positions = new Map([['saved', { top: 700, following:false }]]);
const restored = new ChatScrollController({ get:id => positions.get(id) ?? null, set:(id,value) => positions.set(id,value) });
const restoredSurface = {scrollTop:0,scrollHeight:100,clientHeight:100};
restored.sync('saved',restoredSurface,false); assert.equal(restoredSurface.scrollTop,0);
restored.onScroll(restoredSurface); assert.equal(positions.get('saved').top,700,'empty loading surface cannot erase reading position');
restoredSurface.scrollHeight=4000; restored.sync('saved',restoredSurface,true); assert.equal(restoredSurface.scrollTop,700);
restoredSurface.scrollHeight=4500; restored.sync('saved',restoredSurface); assert.equal(restoredSurface.scrollTop,700);
restored.jumpToLatest(restoredSurface); assert.equal(restored.following,true); assert.equal(positions.get('saved').following,true);

console.log('chat scroll verification passed');
