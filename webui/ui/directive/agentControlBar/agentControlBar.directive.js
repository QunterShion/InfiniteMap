angular.module('kityminderEditor').directive('agentControlBar', [
	'agentSessionService',
	'agentSessionI18n',
	function(agentSessionService, agentSessionI18n) {
		return {
			restrict: 'A',
			replace: true,
			templateUrl: 'ui/directive/agentControlBar/agentControlBar.html',
			link: function(scope) {
				var modelLoadProviderId = null;
				scope.agentControl = {
					providers: [],
					models: [],
					efforts: [],
					input: '',
					busy: true,
					document: {},
					error: null,
					installCandidate: null,
					installation: null,
					authCandidate: null,
					inputRequest: null,
					mcpConnection: { state: 'connecting', attempt: 0, retryable: true, busy: false },
					collapsed: false,
					providerMenuOpen: false,
					configMenuOpen: false
				};

				function statusLabel(provider) {
					return agentSessionI18n.t(provider.installState || 'unavailable');
				}

				function selectedProvider() {
					return scope.agentControl.providers.find(function(provider) {
						return provider.id === scope.agentControl.providerId;
					});
				}

				function selectDefaults() {
					var selected = scope.agentControl.providers.find(function(provider) {
						return provider.id === scope.agentControl.providerId;
					});
					if (!selected) {
						selected = scope.agentControl.providers.find(function(provider) {
							return provider.installState === 'ready' || provider.installState === 'installed_inactive';
						}) || scope.agentControl.providers[0];
						scope.agentControl.providerId = selected && selected.id;
					}
					if (selected && selected.models && selected.models.length) {
						setModels(selected.models);
					}
					ensureSelectedProviderModels(selected);
				}

				function ensureSelectedProviderModels(provider) {
					if (!provider || scope.agentControl.models.length || scope.agentControl.modelId ||
						provider.installState === 'missing' || provider.installState === 'auth_required' ||
						provider.installState === 'failed' || provider.installState === 'incompatible' ||
						modelLoadProviderId === provider.id) {
						return;
					}
					modelLoadProviderId = provider.id;
					scope.agentControl.busy = true;
					agentSessionService.listModels(provider.id).then(function(result) {
						modelLoadProviderId = null;
						scope.agentControl.busy = false;
						scope.agentControl.error = null;
						updateProviderDescriptor(result.descriptor);
						if (result.descriptor && result.descriptor.installState === 'auth_required') {
							scope.agentControl.authCandidate = result.descriptor;
							setModels([]);
							return;
						}
						setModels(result.models || result.descriptor && result.descriptor.models || []);
					}, function(error) {
						modelLoadProviderId = null;
						scope.agentControl.busy = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				}

				function setModels(models) {
					scope.agentControl.models = models || [];
					var selected = scope.agentControl.models.find(function(model) {
						return model.id === scope.agentControl.modelId;
					});
					if (!selected) {
						selected = scope.agentControl.models[0];
						scope.agentControl.modelId = selected && selected.id;
					}
					setEfforts(selected);
				}

				function setEfforts(model) {
					scope.agentControl.efforts = model && model.effortOptions || [];
					var valid = scope.agentControl.efforts.some(function(effort) {
						return effort.id === scope.agentControl.effort;
					});
					if (!valid) {
						scope.agentControl.effort = model && model.defaultEffort ||
							(scope.agentControl.efforts[0] && scope.agentControl.efforts[0].id);
					}
				}

				function updateProviderDescriptor(descriptor) {
					if (!descriptor) return;
					var index = scope.agentControl.providers.findIndex(function(provider) {
						return provider.id === descriptor.id;
					});
					if (index >= 0) {
						scope.agentControl.providers[index] = descriptor;
					}
				}

				function applySnapshot(value) {
					value = value || {};
					scope.agentControl.providers = value.providers || scope.agentControl.providers;
					scope.agentControl.session = agentSessionService.normalizeSession(value.session);
					scope.agentControl.document = value.document || scope.agentControl.document;
					scope.agentControl.mcpConnection = Object.assign(
						{},
						scope.agentControl.mcpConnection,
						value.mcpConnection || {}
					);
					if (value.session) {
						scope.agentControl.providerId = value.session.session.provider;
						scope.agentControl.modelId = value.session.requestedConfig && value.session.requestedConfig.modelId || value.session.session.modelId;
						scope.agentControl.effort = value.session.requestedConfig && value.session.requestedConfig.effort || value.session.session.effort;
					}
					selectDefaults();
				}

				function complete(promise, onSuccess) {
					promise.then(function(result) {
						scope.agentControl.busy = false;
						if (scope.agentControl.error === agentSessionI18n.t('mcpOperationFailed')) {
							scope.agentControl.error = agentSessionI18n.t('mcpReconnectedRetry');
						}
						if (onSuccess) onSuccess(result);
					}, function(error) {
						scope.agentControl.busy = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				}

				scope.providerOptionLabel = function(provider) {
					if (provider.installState === 'ready') {
						return provider.displayName;
					}
					return provider.displayName + ' · ' + statusLabel(provider);
				};

				scope.selectedProviderLabel = function() {
					var provider = selectedProvider();
					return provider ? provider.displayName : agentSessionI18n.t('switchProvider');
				};

				scope.selectedModelLabel = function() {
					var model = scope.agentControl.models.find(function(candidate) {
						return candidate.id === scope.agentControl.modelId;
					});
					return model ? model.label : agentSessionI18n.t('defaultModel');
				};

				scope.selectedEffortLabel = function() {
					var effort = scope.agentControl.efforts.find(function(candidate) {
						return candidate.id === scope.agentControl.effort;
					});
					return effort && effort.label || '';
				};

				scope.configurationLabel = function() {
					var effort = scope.selectedEffortLabel();
					return scope.selectedModelLabel() + (effort ? ' · ' + effort : '');
				};

				scope.toggleCollapse = function() {
					scope.agentControl.providerMenuOpen = false;
					scope.agentControl.configMenuOpen = false;
					scope.agentControl.collapsed = !scope.agentControl.collapsed;
				};

				scope.toggleProviderMenu = function() {
					scope.agentControl.configMenuOpen = false;
					scope.agentControl.providerMenuOpen = !scope.agentControl.providerMenuOpen;
				};

				scope.toggleConfigMenu = function() {
					scope.agentControl.providerMenuOpen = false;
					scope.agentControl.configMenuOpen = !scope.agentControl.configMenuOpen;
				};

				scope.selectProviderFromMenu = function(provider) {
					scope.agentControl.providerId = provider.id;
					scope.agentControl.providerMenuOpen = false;
					scope.providerChanged();
				};

				scope.selectModelFromMenu = function(model) {
					scope.agentControl.modelId = model.id;
					scope.agentControl.configMenuOpen = false;
					scope.modelChanged();
				};

				scope.selectEffortFromMenu = function(effort) {
					scope.agentControl.effort = effort.id;
					scope.agentControl.configMenuOpen = false;
				};

				scope.selectedProviderNeedsInstall = function() {
					var provider = selectedProvider();
					return !!provider && provider.installState === 'missing' && !scope.agentControl.installation;
				};

				scope.requestSelectedProviderInstall = function() {
					var provider = selectedProvider();
					if (provider && provider.installState === 'missing') {
						scope.agentControl.installCandidate = provider;
					}
				};

				scope.providerChanged = function() {
					var provider = selectedProvider();
					scope.agentControl.providerMenuOpen = false;
					scope.agentControl.configMenuOpen = false;
					modelLoadProviderId = null;
					scope.agentControl.modelId = null;
					scope.agentControl.effort = null;
					scope.agentControl.models = [];
					scope.agentControl.efforts = [];
					scope.agentControl.error = null;
					if (!provider) return;
					if (provider.installState === 'missing') {
						scope.agentControl.installCandidate = provider;
						return;
					}
					if (provider.installState === 'auth_required') {
						scope.agentControl.authCandidate = provider;
						return;
					}
					if (provider.models && provider.models.length) {
						setModels(provider.models);
						return;
					}
					ensureSelectedProviderModels(provider);
				};

				scope.modelChanged = function() {
					var model = scope.agentControl.models.find(function(candidate) {
						return candidate.id === scope.agentControl.modelId;
					});
					setEfforts(model);
				};

				scope.confirmProviderInstall = function() {
					var provider = scope.agentControl.installCandidate;
					if (!provider) return;
					startProviderInstall(provider);
				};

				scope.cancelProviderInstall = function() {
					scope.agentControl.installCandidate = null;
				};

				function startProviderInstall(provider) {
					scope.agentControl.installCandidate = null;
					scope.agentControl.installation = {
						provider: provider,
						phase: 'opening',
						error: null,
						descriptor: null
					};
					agentSessionService.installProvider(provider.id).then(function(result) {
						var installation = result && result.installation || {};
						scope.agentControl.installation.phase = 'completed';
						scope.agentControl.installation.descriptor = installation.descriptor || null;
						if (installation.descriptor && installation.descriptor.models) {
							setModels(installation.descriptor.models);
						}
						agentSessionService.discoverProviders().then(applySnapshot);
					}, function(error) {
						if (!scope.agentControl.installation) return;
						scope.agentControl.installation.phase = 'failed';
						scope.agentControl.installation.error = error && error.message || String(error);
					});
				}

				scope.retryProviderInstall = function() {
					var installation = scope.agentControl.installation;
					if (!installation || installation.phase !== 'failed') return;
					startProviderInstall(installation.provider);
				};

				scope.closeProviderInstallation = function() {
					var installation = scope.agentControl.installation;
					if (!installation || scope.isProviderInstalling()) return;
					scope.agentControl.installation = null;
					if (installation.descriptor && installation.descriptor.installState === 'auth_required') {
						scope.agentControl.authCandidate = installation.descriptor;
					}
				};

				scope.isProviderInstalling = function() {
					var phase = scope.agentControl.installation && scope.agentControl.installation.phase;
					return phase === 'opening' || phase === 'waiting' || phase === 'verifying';
				};

				scope.providerInstallProgressValue = function() {
					var phase = scope.agentControl.installation && scope.agentControl.installation.phase;
					return { opening: 1, waiting: 2, verifying: 3, completed: 3 }[phase] || 1;
				};

				scope.providerInstallStatusLabel = function() {
					var phase = scope.agentControl.installation && scope.agentControl.installation.phase;
					return agentSessionI18n.t({
						opening: 'installOpening',
						waiting: 'installWaiting',
						verifying: 'installVerifying',
						completed: 'installCompleted',
						failed: 'installFailed'
					}[phase] || 'installOpening');
				};
				scope.confirmProviderAuth = function() {
					var provider = scope.agentControl.authCandidate;
					if (!provider) return;
					scope.agentControl.busy = true;
					complete(agentSessionService.authenticateProvider(provider.id), function() {
						scope.agentControl.authCandidate = null;
						scope.agentControl.busy = true;
						complete(agentSessionService.discoverProviders(), applySnapshot);
					});
				};
				scope.cancelProviderAuth = function() {
					scope.agentControl.authCandidate = null;
				};

				function submissionPayload() {
					return {
						providerId: scope.agentControl.providerId,
						modelId: scope.agentControl.modelId,
						effort: scope.agentControl.effort,
						input: scope.agentControl.input || '',
						nodeId: window.infiniteMapSelectedNodeId || undefined,
						idempotencyKey: window.crypto && window.crypto.randomUUID
							? window.crypto.randomUUID()
							: 'submission-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
					};
				}

				scope.sendAgentSession = function() {
					if (!scope.canSendAgentSession()) return;
					scope.agentControl.busy = true;
					scope.agentControl.error = null;

					// 添加 30 秒超时保护
					var timeoutId = setTimeout(function() {
						scope.agentControl.busy = false;
						scope.agentControl.error = '请求超时（30秒），请检查网络连接或重试';
						scope.$apply();
					}, 30000);

					agentSessionService.send(submissionPayload()).then(function(result) {
						clearTimeout(timeoutId);
						scope.agentControl.busy = false;
						scope.agentControl.error = null;
						scope.agentControl.session = agentSessionService.normalizeSession(result.session);
						scope.agentControl.input = '';
					}, function(error) {
						clearTimeout(timeoutId);
						scope.agentControl.busy = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				};

				scope.appendAgentSession = function() {
					if (!scope.canAppendAgentSession()) return;
					var payload = submissionPayload();
					payload.expectedTurnId = scope.agentControl.session.activeTurnId;
					scope.agentControl.busy = true;
					scope.agentControl.error = null;

					// 添加 30 秒超时保护
					var timeoutId = setTimeout(function() {
						scope.agentControl.busy = false;
						scope.agentControl.error = '请求超时（30秒），请检查网络连接或重试';
						scope.$apply();
					}, 30000);

					agentSessionService.append(payload).then(function(result) {
						clearTimeout(timeoutId);
						scope.agentControl.busy = false;
						scope.agentControl.error = null;
						scope.agentControl.session = agentSessionService.normalizeSession(result.session);
						scope.agentControl.input = '';
					}, function(error) {
						clearTimeout(timeoutId);
						scope.agentControl.busy = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				};

				scope.interruptAgentSession = function() {
					if (!scope.canInterruptAgentSession()) return;
					scope.agentControl.busy = true;
					complete(agentSessionService.interrupt(scope.agentControl.session.activeTurnId), function(result) {
						scope.agentControl.session = agentSessionService.normalizeSession(result.session);
					});
				};

				scope.openAgentActivity = function() {
					document.dispatchEvent(new CustomEvent('agent-activity-open'));
				};

				scope.mcpConnectionLabel = function() {
					var state = scope.agentControl.mcpConnection.state;
					return agentSessionI18n.t({
						ready: 'mcpReady',
						connecting: 'mcpConnecting',
						reconnecting: 'mcpReconnecting',
						unavailable: 'mcpUnavailable'
					}[state] || 'mcpUnavailable');
				};

				scope.reconnectMcp = function() {
					var connection = scope.agentControl.mcpConnection;
					if (connection.busy || connection.state === 'ready') return;
					connection.busy = true;
					connection.state = 'reconnecting';
					agentSessionService.reconnectMcp().then(function(result) {
						scope.agentControl.mcpConnection = Object.assign(
							{},
							connection,
							result.connection || { state: 'ready' },
							{ busy: false }
						);
						if (scope.agentControl.error === agentSessionI18n.t('mcpOperationFailed')) {
							scope.agentControl.error = agentSessionI18n.t('mcpReconnectedRetry');
						}
					}, function(error) {
						connection.busy = false;
						connection.state = 'unavailable';
						scope.agentControl.error = error && error.message || String(error);
					});
				};

				scope.resolveAgentInput = function(decision) {
					var request = scope.agentControl.inputRequest;
					if (!request || request.resolving) return;
					request.resolving = true;
					agentSessionService.resolveInput(request.requestId, decision, request.value).then(function() {
						scope.agentControl.inputRequest = null;
					}, function(error) {
						request.resolving = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				};

				scope.canSendAgentSession = function() {
					return !!(!scope.agentControl.busy && !scope.agentControl.document.dirty &&
						!scope.agentControl.document.conflict && scope.agentControl.providerId &&
						scope.agentControl.modelId && !(scope.agentControl.session && scope.agentControl.session.activeTurnId));
				};

				scope.canAppendAgentSession = function() {
					return !!(!scope.agentControl.busy && !scope.agentControl.document.dirty &&
						!scope.agentControl.document.conflict && scope.agentControl.session && scope.agentControl.modelId);
				};

				scope.canInterruptAgentSession = function() {
					return !!(!scope.agentControl.busy && scope.agentControl.session && scope.agentControl.session.activeTurnId);
				};

				scope.getPrimaryActionState = function() {
					if (scope.agentControl.session && scope.agentControl.session.activeTurnId) {
						return 'interrupt';
					}
					if (scope.agentControl.session) {
						return 'append';
					}
					return 'send';
				};

				scope.canPerformPrimaryAction = function() {
					var state = scope.getPrimaryActionState();
					if (state === 'interrupt') return scope.canInterruptAgentSession();
					if (state === 'append') return scope.canAppendAgentSession();
					return scope.canSendAgentSession();
				};

				scope.handlePrimaryAction = function() {
					var state = scope.getPrimaryActionState();
					if (state === 'interrupt') {
						scope.interruptAgentSession();
						return;
					}
					if (state === 'append') {
						scope.appendAgentSession();
						return;
					}
					scope.sendAgentSession();
				};

				scope.primaryActionLabel = function() {
					var state = scope.getPrimaryActionState();
					if (state === 'interrupt') return agentSessionI18n.t('interrupt');
					if (state === 'append') return agentSessionI18n.t('append');
					if (scope.agentControl.busy) return agentSessionI18n.t('sending');
					return agentSessionI18n.t('send');
				};

				scope.handleComposerKeydown = function(event) {
					if (!event || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
					event.preventDefault();
					if (scope.canPerformPrimaryAction()) scope.handlePrimaryAction();
				};

				scope.$on('agent-session-snapshot', function(_event, value) {
					applySnapshot(value);
				});
				scope.$on('agent-session-event', function(_event, value) {
					if (!scope.agentControl.session || value.executionId !== scope.agentControl.session.executionId) return;
					if (value.type === 'session.input.required' && value.payload && value.payload.requestId) {
						scope.agentControl.inputRequest = Object.assign({ value: '', resolving: false }, value.payload);
					}
					if (value.type === 'session.state.changed' && value.payload && value.payload.status) {
						scope.agentControl.session.status = value.payload.status;
						scope.agentControl.session.activeTurnId = value.payload.activeTurnId;
					}
					if (value.type === 'session.completed') {
						scope.agentControl.session.activeTurnId = null;
						scope.agentControl.session.status = 'idle';
					}
				});
				scope.$on('agent-provider-install-progress', function(_event, value) {
					var installation = scope.agentControl.installation;
					if (!installation || value.providerId !== installation.provider.id) return;
					installation.phase = value.phase;
					if (value.error) installation.error = value.error.message;
				});
				scope.$on('mcp-connection-state', function(_event, value) {
					scope.agentControl.mcpConnection = Object.assign(
						{},
						scope.agentControl.mcpConnection,
						value,
						{ busy: false }
					);
					if (value.state === 'ready' && scope.agentControl.error &&
						scope.agentControl.error === agentSessionI18n.t('mcpOperationFailed')) {
						scope.agentControl.error = agentSessionI18n.t('mcpReconnectedRetry');
					}
				});

				applySnapshot(agentSessionService.getSnapshot());
				complete(agentSessionService.discoverProviders(), applySnapshot);
			}
		};
	}
]);
