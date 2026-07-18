angular.module('kityminderEditor')
    .directive('searchBox', function() {
        return {
            restrict: 'A',
            templateUrl: 'ui/directive/searchBox/searchBox.html',
            scope: {
                minder: '='
            },
            replace: true,
            controller: function ($scope) {
                var minder = $scope.minder;
                var editor = window.editor;
                var $body = $('body');
                var nodeSequence = [];
                var searchSequence = [];

                $scope.handleSearchKeyDown = handleSearchKeyDown;
                $scope.handleReplaceKeyDown = handleReplaceKeyDown;
                $scope.doSearch = doSearch;
                $scope.doReplace = doReplace;
                $scope.exitSearch = exitSearch;
                $scope.toggleReplace = toggleReplace;
                $scope.showTip = false;
                $scope.showSearch = false;
                $scope.showReplace = false;
                $scope.replacePerformed = false;

                function handleSearchKeyDown(e) {
                    if (e.keyCode == 13) {
                        var direction = e.shiftKey ? 'prev' : 'next';
                        doSearch($scope.keyword, direction);
                    }
                    if (e.keyCode == 27) {
                        exitSearch();
                    }
                }

                function handleReplaceKeyDown(e) {
                    if (e.keyCode == 13) {
                        doReplace(e.ctrlKey || e.metaKey);
                    }
                    if (e.keyCode == 27) {
                        exitSearch();
                    }
                }

                function exitSearch() {
                    $('#search-input').blur();
                    $('#replace-input').blur();
                    $scope.showSearch = false;
                    minder.fire('hidenoterequest');
                    editor.receiver.selectAll();
                }

                function enterSearch(replaceMode) {
                    $scope.showSearch = true;
                    if (replaceMode) {
                        $scope.showReplace = true;
                    }
                    setTimeout(function() {
                        $(replaceMode ? '#replace-input' : '#search-input').focus();
                    }, 10);

                    if ($scope.keyword) {
                        $('#search-input')[0].setSelectionRange(0, $scope.keyword.length);
                    }
                }

                function toggleReplace() {
                    $scope.showReplace = !$scope.showReplace;
                    if ($scope.showReplace) {
                        setTimeout(function() {
                            $('#replace-input').focus();
                        }, 10);
                    }
                }

                function handleShortcut(e) {
                    if (e.keyCode == 70 && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
                        enterSearch(false);

                        $scope.$apply();
                        e.preventDefault();
                    }
                    if (e.keyCode == 72 && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
                        enterSearch(true);

                        $scope.$apply();
                        e.preventDefault();
                    }
                }

                $body.on('keydown', handleShortcut);

                $scope.$on('$destroy', function() {
                    $body.off('keydown', handleShortcut);
                });

                minder.on('searchNode', function() {
                    enterSearch(false);
                });

                minder.on('contentchange', makeNodeSequence);

                makeNodeSequence();


                function makeNodeSequence() {
                    nodeSequence = [];
                    minder.getRoot().traverse(function(node) {
                        nodeSequence.push(node);
                    });
                    searchSequence = [];
                    doSearch.lastKeyword = null;
                    doSearch.lastIndex = -1;
                    $scope.currentMatch = null;
                }

                function makeSearchSequence(keyword) {
                    searchSequence = [];

                    for (var i = 0; i < nodeSequence.length; i++) {
                        var node = nodeSequence[i];
                        var text = (node.getText() || '').toLowerCase();
                        if (text.indexOf(keyword) != -1) {
                            searchSequence.push({node: node, field: 'text'});
                        }
                        var note = node.getData('note');
                        if (note && note.toLowerCase().indexOf(keyword) != -1) {
                            searchSequence.push({node: node, field: 'note', keyword: keyword});
                        }
                    }
                }


                function doSearch(keyword, direction) {
                    $scope.showTip = false;
                    minder.fire('hidenoterequest');

                    if (!keyword || !/\S/.exec(keyword)) {
                        $('#search-input').focus();
                        return;
                    }

                    // 当搜索不到节点时候默认的选项
                    $scope.showTip = true;
                    $scope.curIndex = 0;
                    $scope.resultNum = 0;

                    keyword = keyword.toLowerCase();
                    var newSearch = doSearch.lastKeyword != keyword;

                    doSearch.lastKeyword = keyword;

                    if (newSearch) {
                        makeSearchSequence(keyword);
                    }

                    $scope.resultNum = searchSequence.length;

                    if (searchSequence.length) {
                        var curIndex = newSearch ? 0 : (direction === 'next' ? doSearch.lastIndex + 1 : doSearch.lastIndex - 1) || 0;
                        curIndex = (searchSequence.length + curIndex) % searchSequence.length;

                        $scope.currentMatch = searchSequence[curIndex];
                        setSearchResult($scope.currentMatch.node, $scope.currentMatch.keyword);

                        doSearch.lastIndex = curIndex;

                        $scope.curIndex = curIndex + 1;

                        function setSearchResult(node, previewKeyword) {
                            minder.execCommand('camera', node, 50);
                            setTimeout(function () {
                                minder.select(node, true);
                                if (!node.isExpanded()) minder.execCommand('expand', true);
                                if (previewKeyword) {
                                    minder.fire('shownoterequest', {node: node, keyword: previewKeyword});
                                }
                            }, 60);
                        }
                    } else {
                        $scope.currentMatch = null;
                    }
                }

                function escapeRegExp(text) {
                    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                }

                function replaceValue(value, keyword, replacement, replaceAll) {
                    var expression = new RegExp(escapeRegExp(keyword), replaceAll ? 'gi' : 'i');
                    var count = 0;
                    var nextValue = value.replace(expression, function() {
                        count++;
                        return replacement;
                    });

                    return {
                        count: count,
                        value: nextValue
                    };
                }

                function getMatchValue(match) {
                    if (match.field == 'note') {
                        return match.node.getData('note') || '';
                    }
                    return match.node.getText() || '';
                }

                function setMatchValue(match, value) {
                    if (match.field == 'note') {
                        match.node.setData('note', value);
                    } else {
                        match.node.setText(value);
                    }
                }

                function finishReplacement(changedNodes) {
                    changedNodes.forEach(function(node) {
                        node.render();
                    });
                    minder.layout(300);
                    minder.fire('contentchange');
                }

                function replaceCurrent(keyword, replacement) {
                    var normalizedKeyword = keyword.toLowerCase();
                    var match = $scope.currentMatch;

                    if (!match || doSearch.lastKeyword != normalizedKeyword || getMatchValue(match).toLowerCase().indexOf(normalizedKeyword) == -1) {
                        doSearch(keyword, 'next');
                        match = $scope.currentMatch;
                    }

                    if (!match) {
                        return 0;
                    }

                    var result = replaceValue(getMatchValue(match), keyword, replacement, false);
                    if (result.count) {
                        setMatchValue(match, result.value);
                        finishReplacement([match.node]);
                        doSearch(keyword, 'next');
                    }

                    return result.count;
                }

                function replaceAll(keyword, replacement) {
                    var count = 0;
                    var changedNodes = [];

                    nodeSequence.forEach(function(node) {
                        var nodeChanged = false;
                        var textResult = replaceValue(node.getText() || '', keyword, replacement, true);
                        var note = node.getData('note');

                        if (textResult.count) {
                            node.setText(textResult.value);
                            count += textResult.count;
                            nodeChanged = true;
                        }

                        if (note) {
                            var noteResult = replaceValue(note, keyword, replacement, true);
                            if (noteResult.count) {
                                node.setData('note', noteResult.value);
                                count += noteResult.count;
                                nodeChanged = true;
                            }
                        }

                        if (nodeChanged) {
                            changedNodes.push(node);
                        }
                    });

                    if (changedNodes.length) {
                        finishReplacement(changedNodes);
                    }

                    return count;
                }

                function doReplace(replaceEveryMatch) {
                    var keyword = $scope.keyword;
                    if (!keyword || !/\S/.test(keyword)) {
                        $('#search-input').focus();
                        return;
                    }

                    var replacement = $scope.replacement || '';
                    $scope.replaceCount = replaceEveryMatch ?
                        replaceAll(keyword, replacement) :
                        replaceCurrent(keyword, replacement);
                    $scope.replacePerformed = true;
                }

            }
        }
    });
