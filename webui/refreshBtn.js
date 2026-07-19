/**
 * infiniteMap refresh button injection script.
 * Loaded after kityminder.editor.min.js and before main.js.
 */
(function() {
    var RETRY_DELAY = 100;
    var REFRESH_TIMEOUT = 15000;
    var STYLE_ID = 'infinite-map-refresh-style';
    var refreshSequence = 0;
    var activeRefreshId;
    var activeRefreshTimer;
    var $activeRefreshBtn;
    var activeDraftSuppression;

    // Angular renders the toolbar asynchronously. Retry until the undo/redo
    // group exists instead of assuming that the tab strip is enough.
    function injectRefreshBtn() {
        var $doGroup = $('.do-group');
        if (!$doGroup.length) {
            setTimeout(injectRefreshBtn, RETRY_DELAY);
            return;
        }

        if ($doGroup.find('.refresh-from-disk-btn').length || $('.refresh-from-disk-btn').length) {
            return;
        }

        ensureRefreshStyle();

        // Match oorzc.mind-map's refresh glyph while keeping keyboard support.
        var $refreshBtn = $(
            '<div id="infinite-map-refresh-btn" class="km-btn-item refresh-from-disk-btn"' +
            ' role="button" tabindex="0" aria-label="从磁盘刷新 (Refresh from Disk)"' +
            ' title="从磁盘刷新 (Refresh from Disk)">' +
            '  <span class="km-btn-icon">' +
            '    <svg class="mindmap-refresh-icon" viewBox="0 0 24 24" fill="none"' +
            '      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 15"></path>' +
            '      <path d="M3 21v-6h6"></path>' +
            '      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 9"></path>' +
            '      <path d="M21 3v6h-6"></path>' +
            '    </svg>' +
            '  </span>' +
            '</div>'
        );

        $refreshBtn.on('click', function(e) {
            e.preventDefault();
            requestRefresh($refreshBtn);
        });
        $refreshBtn.on('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
                e.preventDefault();
                requestRefresh($refreshBtn);
            }
        });

        $doGroup.append($refreshBtn);
    }

    function ensureRefreshStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        // These values intentionally mirror oorzc.mind-map@1.0.6.
        var css = ''
            + '.refresh-from-disk-btn .km-btn-icon{'
            +   'background:none;box-sizing:border-box;color:#555;line-height:0;text-align:center;'
            + '}'
            + '.refresh-from-disk-btn .mindmap-refresh-icon{'
            +   'width:16px;height:16px;margin:2px;stroke:currentColor;'
            + '}'
            + '.refresh-from-disk-btn:hover .km-btn-icon,'
            + '.refresh-from-disk-btn:focus .km-btn-icon{color:#222;}'
            + '.refresh-from-disk-btn[aria-disabled="true"]{'
            +   'pointer-events:none;opacity:0.5;'
            + '}';

        $('<style id="' + STYLE_ID + '">').text(css).appendTo('head');
    }

    function createRefreshId() {
        refreshSequence += 1;
        return (window.infiniteMapWebviewSessionId || 'webview') + ':refresh:' + refreshSequence;
    }

    function requestRefresh($refreshBtn) {
        if (activeRefreshId || !window.vscode || typeof window.vscode.postMessage !== 'function') {
            return;
        }

        var requestId = createRefreshId();
        activeRefreshId = requestId;
        activeDraftSuppression = 'refresh-pending:' + requestId;
        if (typeof window.infiniteMapAcquireDraftSuppression === 'function') {
            window.infiniteMapAcquireDraftSuppression(activeDraftSuppression);
        } else {
            window.infiniteMapRefreshDraftSuppression = activeDraftSuppression;
            window.mindmapSuppressDraft = true;
        }
        $activeRefreshBtn = $refreshBtn;
        $refreshBtn.attr('aria-disabled', 'true').attr('aria-busy', 'true');
        activeRefreshTimer = window.setTimeout(function() {
            finishRefresh(requestId);
        }, REFRESH_TIMEOUT);

        try {
            // acquireVsCodeApi().postMessage() returns void. Completion arrives
            // through an explicit refreshResult message from the provider.
            window.vscode.postMessage({ command: 'refresh', requestId: requestId });
        } catch (error) {
            finishRefresh(requestId);
        }
    }

    function finishRefresh(requestId) {
        if (!activeRefreshId || requestId !== activeRefreshId) {
            return;
        }
        window.clearTimeout(activeRefreshTimer);
        if ($activeRefreshBtn) {
            $activeRefreshBtn.removeAttr('aria-disabled').removeAttr('aria-busy');
        }
        if (activeDraftSuppression) {
            if (typeof window.infiniteMapReleaseDraftSuppression === 'function') {
                window.infiniteMapReleaseDraftSuppression(activeDraftSuppression);
            } else {
                window.infiniteMapRefreshDraftSuppression = undefined;
                window.mindmapSuppressDraft = false;
            }
        }
        activeRefreshId = undefined;
        activeRefreshTimer = undefined;
        $activeRefreshBtn = undefined;
        activeDraftSuppression = undefined;
    }

    function watchToolbar() {
        if (!window.MutationObserver || !document.body) {
            return;
        }
        var observer = new window.MutationObserver(function() {
            if (!document.getElementById('infinite-map-refresh-btn')) {
                injectRefreshBtn();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('message', function(event) {
        var message = event.data;
        if (message && message.command === 'refreshResult') {
            finishRefresh(message.requestId);
        }
    });

    $(document).ready(function() {
        injectRefreshBtn();
        watchToolbar();
    });
})();
