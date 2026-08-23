angular.module('kityminderEditor').directive('agentSessionDock', function() {
	return {
		restrict: 'A',
		templateUrl: 'ui/directive/agentSessionDock/agentSessionDock.html',
		link: function(scope) {
			var drawerNames = ['activity', 'history'];
			scope.sessionDock = { activeDrawer: null };

			function apply() {
				if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
			}

			function dispatch(name, detail) {
				document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
			}

			function closeDrawer(drawer, restoreFocus) {
				dispatch(drawer === 'activity' ? 'agent-activity-close' : 'agent-session-history-close', {
					restoreFocus: restoreFocus === true
				});
			}

			function openDrawer(drawer) {
				if (drawer === 'activity') {
					dispatch('agent-activity-open', { source: 'session-dock' });
					return;
				}
				dispatch('agent-session-history-open', { source: 'session-dock' });
			}

			function focusTab(drawer) {
				window.setTimeout(function() {
					var tab = document.querySelector('[data-component="agent-session-dock"] [data-drawer="' + drawer + '"]');
					if (tab && tab.focus) tab.focus();
				}, 0);
			}

			function syncDrawerState(event) {
				var detail = event.detail || {};
				if (drawerNames.indexOf(detail.drawer) === -1) return;
				if (detail.open) {
					scope.sessionDock.activeDrawer = detail.drawer;
				} else if (scope.sessionDock.activeDrawer === detail.drawer) {
					scope.sessionDock.activeDrawer = null;
					if (detail.restoreFocus) focusTab(detail.drawer);
				}
				apply();
			}

			function handleEscape(event) {
				if (event.key !== 'Escape' || !scope.sessionDock.activeDrawer) return;
				closeDrawer(scope.sessionDock.activeDrawer, true);
			}

			function isAgentControlSurface(event) {
				var target = event && event.target;
				var path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
				for (var index = 0; index < path.length; index += 1) {
					var pathElement = path[index];
					if (pathElement && pathElement.getAttribute &&
						pathElement.getAttribute('data-agent-control-surface') !== null) return true;
				}
				if (!target) return false;
				var candidate = target.nodeType === 1 ? target : target.parentNode;
				while (candidate && candidate !== document) {
					if (candidate.getAttribute && candidate.getAttribute('data-agent-control-surface') !== null) {
						return true;
					}
					candidate = candidate.parentNode;
				}
				return false;
			}

			function handleDocumentClick(event) {
				if (!scope.sessionDock.activeDrawer || isAgentControlSurface(event)) return;
				closeDrawer(scope.sessionDock.activeDrawer, false);
			}

			scope.toggleSessionDrawer = function(drawer) {
				if (drawerNames.indexOf(drawer) === -1) return;
				if (scope.sessionDock.activeDrawer === drawer) {
					closeDrawer(drawer, true);
					return;
				}
				openDrawer(drawer);
			};

			scope.handleSessionDockKeydown = function(event, drawer) {
				var currentIndex = drawerNames.indexOf(drawer);
				var nextIndex = currentIndex;
				if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = currentIndex - 1;
				else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = currentIndex + 1;
				else if (event.key === 'Home') nextIndex = 0;
				else if (event.key === 'End') nextIndex = drawerNames.length - 1;
				else return;
				event.preventDefault();
				nextIndex = (nextIndex + drawerNames.length) % drawerNames.length;
				openDrawer(drawerNames[nextIndex]);
				focusTab(drawerNames[nextIndex]);
			};

			document.addEventListener('agent-session-drawer-state', syncDrawerState);
			document.addEventListener('keydown', handleEscape);
			document.addEventListener('click', handleDocumentClick);
			scope.$on('$destroy', function() {
				document.removeEventListener('agent-session-drawer-state', syncDrawerState);
				document.removeEventListener('keydown', handleEscape);
				document.removeEventListener('click', handleDocumentClick);
			});
		}
	};
});
