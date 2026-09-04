define(function (require, exports, module) {
  function NodeRuntime() {
    var runtime = this;
    var minder = this.minder;
    var hotbox = this.hotbox;
    var fsm = this.fsm;
    var lang = this.lang.t;

    var main = hotbox.state('main');

    // var buttons = [
    //   'Up:Alt+Up:ArrangeUp',
    //   'Append:Tab|Insert:AppendChildNode',
    //   'Sibling:Enter:AppendSiblingNode',
    //   'Down:Alt+Down:ArrangeDown',
    //   'Delete:Delete|Backspace:RemoveNode',
    //   'Append:Shift+Tab|Shift+Insert:AppendParentNode',
    //   //'全选:Ctrl+A:SelectAll'
    // ];

    var buttons = [
      lang('arrangeup', 'runtime/node') + ':Alt+Up:ArrangeUp',
      lang('appendchildnode', 'runtime/node') + ':Tab|Insert:AppendChildNode',
      lang('appendsiblingnode', 'runtime/node') + ':Enter:AppendSiblingNode',
      lang('arrangedown', 'runtime/node') + ':Alt+Down:ArrangeDown',
      lang('removenode', 'runtime/node') + ':Delete|Backspace:RemoveNode',
      lang('appendparentnode', 'runtime/node') + ':Shift+Tab|Shift+Insert:AppendParentNode'
      //lang('selectall', 'runtime/node') + ':Ctrl+A:SelectAll'
    ];

    var AppendLock = 0;

    buttons.forEach(function (button) {
      var parts = button.split(':');
      var label = parts.shift();
      var key = parts.shift();
      var command = parts.shift();
      main.button({
        position: 'ring',
        label: label,
        key: key,
        action: function () {
          if (command.indexOf('Append') === 0) {
            AppendLock++;
            minder.execCommand(command, 'topic');

            // provide in input runtime
            function afterAppend() {
              if (!--AppendLock) {
                runtime.editText();
              }
              minder.off('layoutallfinish', afterAppend);
            }
            minder.on('layoutallfinish', afterAppend);
          } else {
            minder.execCommand(command);
            fsm.jump('normal', 'command-executed');
          }
        },
        enable: function () {
          return minder.queryCommandState(command) != -1;
        },
      });
    });

    main.button({
      position: 'bottom',
      label: 'Import Node',
      key: 'Alt + V',
      enable: function () {
        var selectedNodes = minder.getSelectedNodes();
        return selectedNodes.length == 1;
      },
      action: importNodeData,
      next: 'idle',
    });

    main.button({
      position: 'bottom',
      label: 'Export Node',
      key: 'Alt + C',
      enable: function () {
        var selectedNodes = minder.getSelectedNodes();
        return selectedNodes.length == 1;
      },
      action: exportNodeData,
      next: 'idle',
    });

    function importNodeData() {
      minder.fire('importNodeData');
    }

    function exportNodeData() {
      minder.fire('exportNodeData');
    }

    // 递归展开所有子节点
    function expandAll(node) {
      var children = node.getChildren();
      if (!children || children.length === 0) return;

      // 先展开当前节点
      if (!node.isExpanded()) {
        minder.execCommand('expand', node);
      }

      // 递归展开所有子节点
      children.forEach(function(child) {
        expandAll(child);
      });
    }

    // 递归收缩所有子节点
    function collapseAll(node) {
      var children = node.getChildren();
      if (!children || children.length === 0) return;

      // 先递归收缩所有子节点
      children.forEach(function(child) {
        collapseAll(child);
      });

      // 再收缩当前节点
      if (node.isExpanded()) {
        minder.execCommand('collapse', node);
      }
    }

    // 检查节点是否有任何收缩的子孙节点
    function hasCollapsedDescendant(node) {
      var children = node.getChildren();
      if (!children || children.length === 0) return false;

      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (!child.isExpanded() && child.getChildren().length > 0) {
          return true;
        }
        if (hasCollapsedDescendant(child)) {
          return true;
        }
      }
      return false;
    }

    main.button({
      position: 'ring',
      label: lang('expandcollapse', 'runtime/node'),
      key: '/',
      action: function(){
        var node = minder.getSelectedNode();
        if (!node) return;

        // 检查是否有收缩的子孙节点
        if (hasCollapsedDescendant(node)) {
          // 有收缩的节点，执行全部展开
          expandAll(node);
        } else {
          // 全部展开状态，执行全部收缩
          collapseAll(node);
        }
        fsm.jump('normal', 'command-executed');
      },
      enable: function() {
        var node = minder.getSelectedNode();
        if (!node) return false;
        var children = node.getChildren();
        return children && children.length > 0;
      },
      beforeShow: function() {
        var node = minder.getSelectedNode();
        if (!node) return;

        if (hasCollapsedDescendant(node)) {
          this.$button.children[0].innerHTML = lang('expandall', 'runtime/node');
        } else {
          this.$button.children[0].innerHTML = lang('collapseall', 'runtime/node');
        }
      }
    })
  }

  return (module.exports = NodeRuntime);
});
