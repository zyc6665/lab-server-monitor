/* 纯函数防抖/节流工具（无 DOM 依赖，可在 node --test 中直接测试）。
 * 用于高频输入（如主机关键字过滤）时合并重复调用，避免每次按键都遍历 DOM。 */

// 返回一个防抖函数：在最后一次调用后 wait 毫秒才真正执行。
// 额外挂载 cancel()/flush()，便于测试与需要“立即执行”的场景复用。
export function debounce(fn, wait) {
  var delay = typeof wait === 'number' ? wait : 200;
  var timer = null;
  var lastArgs = null;
  var lastContext = null;

  function debounced() {
    lastContext = this;
    lastArgs = arguments;
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(function () {
      timer = null;
      var args = lastArgs;
      var context = lastContext;
      lastArgs = null;
      lastContext = null;
      fn.apply(context, args);
    }, delay);
  }

  debounced.cancel = function () {
    if (timer) { clearTimeout(timer); }
    timer = null;
    lastArgs = null;
    lastContext = null;
  };

  debounced.flush = function () {
    if (!timer) { return; }
    clearTimeout(timer);
    timer = null;
    var args = lastArgs;
    var context = lastContext;
    lastArgs = null;
    lastContext = null;
    fn.apply(context, args);
  };

  return debounced;
}
