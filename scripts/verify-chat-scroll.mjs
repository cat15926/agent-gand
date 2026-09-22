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
console.log('chat scroll verification passed');
