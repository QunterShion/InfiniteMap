angular.module('kityminderEditor')
	.directive('kityminderEditor', ['config', 'minder.service', 'revokeDialog', 'nodeSplitDialog', function(config, minderService, revokeDialog, nodeSplitDialog) {
		return {
			restrict: 'EA',
			templateUrl: 'ui/directive/kityminderEditor/kityminderEditor.html',
			replace: true,
			scope: {
				onInit: '&'
			},
			link: function(scope, element, attributes) {
				var $minderEditor = element.children('.minder-editor')[0];
				var canvasResizeObserver;

				function syncCanvasBoundary() {
					if (!element[0] || !element[0].getBoundingClientRect ||
						!$minderEditor || !$minderEditor.getBoundingClientRect) return;
					var containerRect = element[0].getBoundingClientRect();
					var editorRect = $minderEditor.getBoundingClientRect();
					var canvasTop = Math.max(0, editorRect.top - containerRect.top);
					element[0].style.setProperty('--minder-canvas-top', canvasTop + 'px');
				}

				if (window.ResizeObserver) {
					canvasResizeObserver = new window.ResizeObserver(syncCanvasBoundary);
					canvasResizeObserver.observe($minderEditor);
				} else if (window.addEventListener) {
					window.addEventListener('resize', syncCanvasBoundary);
				}
				var scheduleCanvasSync = window.requestAnimationFrame || window.setTimeout;
				if (scheduleCanvasSync) scheduleCanvasSync(syncCanvasBoundary);

				if (scope.$on) {
					scope.$on('$destroy', function() {
						if (canvasResizeObserver) canvasResizeObserver.disconnect();
						if (window.removeEventListener) {
							window.removeEventListener('resize', syncCanvasBoundary);
						}
					});
				}

				function installModifierWheelZoom(minder) {
					var accumulatedDelta = 0;
					var zoomTimer;

					minder.on('premousewheel', function(e) {
						var originEvent = e.originEvent;
						if (!originEvent || (!originEvent.ctrlKey && !originEvent.metaKey)) {
							return;
						}

						var delta = typeof originEvent.wheelDelta == 'number' ?
							originEvent.wheelDelta :
							-originEvent.deltaY;
						if (!delta) {
							return;
						}

						// macOS pinch gestures and Cmd + wheel share the same wheel event.
						// Positive native delta means fingers move apart / wheel moves up.
						e.stopPropagation();
						originEvent.preventDefault();
						accumulatedDelta += delta;

						clearTimeout(zoomTimer);
						zoomTimer = setTimeout(function() {
							minder.execCommand(accumulatedDelta > 0 ? 'zoomin' : 'zoomout');
							accumulatedDelta = 0;
						}, 80);
					});
				}

				function onInit(editor, minder) {
					installModifierWheelZoom(minder);
					scope.onInit({
						editor: editor,
						minder: minder
					});

					minderService.executeCallback();
				}

				if (typeof(seajs) != 'undefined') {
					/* global seajs */
					seajs.config({
						base: './src'
					});

					define('demo', function(require) {
						var Editor = require('editor');
						var lang = config.get('lang');

						var editor = window.editor = new Editor($minderEditor, lang);

						if (window.localStorage.__dev_minder_content) {
							editor.minder.importJson(JSON.parse(window.localStorage.__dev_minder_content));
						}

						editor.minder.on('contentchange', function() {
							window.localStorage.__dev_minder_content = JSON.stringify(editor.minder.exportJson());
						});

						window.minder = window.km = editor.minder;

						scope.editor = editor;
						scope.minder = minder;
                        scope.config = config.get();

                        //scope.minder.setDefaultOptions(scope.config);
						scope.$apply();

						onInit(editor, minder);
					});

					seajs.use('demo');

				} else if (window.kityminder && window.kityminder.Editor) {
                    var lang = config.get('lang');
					var editor = new kityminder.Editor($minderEditor, lang);

					window.editor = scope.editor = editor;
					window.minder = scope.minder = editor.minder;

                    scope.config = config.get();

                    //scope.minder.setDefaultOptions(config.getConfig());

                    onInit(editor, editor.minder);
                }

			}
		}
	}]);
