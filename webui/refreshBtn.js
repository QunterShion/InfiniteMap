/**
 * infiniteMap 刷新按钮注入脚本
 * 在 kityminder.editor.min.js 之后、main.js 之前加载
 * 用 jQuery 直接操作 DOM + 绑定事件
 */
(function() {
    function injectRefreshBtn() {
        var $tabs = $('.nav-tabs');
        if (!$tabs.length) {
            setTimeout(injectRefreshBtn, 200);
            return;
        }

        if ($('.refresh-from-disk-btn').length) {
            return;
        }

        // 注入 CSS：刷新按钮与 undo/redo 同风格
        // 使用标准 SVG data-uri 作为背景，展示国际通用的顺时针旋转刷新图标
        // 使用标准刷新 SVG 图标，base64 内联
        // 源文件: 50-Opensource/刷新.svg
        var svgData = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path d="M960 64v256H704l96.256-96.256C741.376 168.128 652.16 128 551.68 128 306.432 128 106.432 319.36 94.592 560H94.72v120H32.128C32.064 267.264 264.704 31.488 551.68 31.488c169.216 0 320.576 80.256 418.112 204.48L1024 176 960 64zM64 960V704h256l-96.256 96.256C282.624 856.128 371.84 896 472.32 896c245.248 0 445.248-191.36 457.088-432h0.128v-120h62.592c0.064 412.736-232.576 648.512-519.616 648.512-169.216 0-320.576-80.256-418.112-204.48L0 848 64 960z"/></svg>';
        var dataUri = 'url(data:image/svg+xml;base64,' + btoa(svgData) + ')';

        var css = ''
            + '.refresh .km-btn-icon{'
            +   'display:inline-block;width:20px;height:20px;'
            +   'background-image:' + dataUri + ';'
            +   'background-size:20px 20px;'
            +   'background-position:center center;'
            +   'background-repeat:no-repeat;'
            +   'opacity:0.6;'
            + '}'
            + '.refresh:hover .km-btn-icon{'
            +   'opacity:1;'
            + '}';

        $('<style>').text(css).appendTo('head');

        // 按钮 HTML，纯 ICON 无文字
        var $refreshBtn = $(
            '<div class="km-btn-item refresh refresh-from-disk-btn" title="从磁盘刷新 (Refresh from Disk)">' +
            '  <i class="km-btn-icon"></i>' +
            '</div>'
        );

		$refreshBtn.on('click', function(e) {
			e.preventDefault();
			window.mindmapSuppressDraft = true;
			window.clearTimeout(window.mindmapSuppressDraftTimer);
			window.vscode.postMessage({
                command: 'refresh'
            });
        });

        // 注入到 do-group (undo/redo按钮组) 内部，放在 redo 按钮后面
        var $doGroup = $('.do-group');
        if ($doGroup.length) {
            // 扩展 do-group 宽度：原来 38px 容纳 2 个按钮，现在增加到容纳 3 个
            $doGroup.css('width', '57px');
            $doGroup.append($refreshBtn);
        }
    }

    $(document).ready(function() {
        setTimeout(injectRefreshBtn, 500);
    });
})();
