(function () {
  'use strict';

  var game = new Chess();
  var board = null;
  var puzzles = [];
  var index = 0;
  var solved = false;
  var score = { correct: 0, attempts: 0 };
  var selectedSquare = null;

  var SCORE_KEY = 'tactics_trainer_score_v1';

  function loadScore() {
    try {
      var raw = localStorage.getItem(SCORE_KEY);
      if (raw) score = JSON.parse(raw);
    } catch (e) { /* ignore */ }
  }

  function saveScore() {
    try { localStorage.setItem(SCORE_KEY, JSON.stringify(score)); } catch (e) { /* ignore */ }
  }

  function renderScore() {
    $('#score').text('正解 ' + score.correct + ' / 試行 ' + score.attempts + ' 回');
  }

  function fetchJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('failed to load ' + url);
      return res.json();
    });
  }

  function currentPuzzle() {
    return puzzles[index];
  }

  function loadPuzzle(i) {
    index = (i + puzzles.length) % puzzles.length;
    var p = currentPuzzle();
    solved = false;
    clearSelection();

    game.load(p.fen);
    board.orientation(p.orientation === 'black' ? 'black' : 'white');
    board.position(p.fen, false);

    var TYPE_LABELS = {
      mate_found: 'チェックメイトを決めた一局',
      material_found: '駒得・優勢を決めた一局',
      mate_missed: '見逃したメイトを発見しよう',
      material_missed: '見逃した駒得タクティクスを発見しよう'
    };
    var typeLabel = TYPE_LABELS[p.type] || '';
    $('#progress').text('問題 ' + (index + 1) + ' / ' + puzzles.length);
    $('#puzzle-title').text('問題 ' + (index + 1) + ' — ' + typeLabel);
    var prevLine = p.prev_san ? ('直前の相手の手: ' + escapeHtml(p.prev_san) + '<br/>') : '';
    $('#puzzle-meta').html(
      '対 ' + escapeHtml(p.opponent) + ' / ' + p.date + '<br/>' +
      escapeHtml(p.opening || '') + '<br/>' +
      prevLine
    );
    $('#side-to-move').text((p.orientation === 'white' ? '白' : '黒') + ' 番 — あなたの手番です');
    $('#lichess-link').attr('href', p.lichess_url);
    $('#game-link').attr('href', p.game_url);

    $('#answer-box').addClass('hidden');
    $('#feedback').attr('class', 'feedback').text('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showAnswer() {
    var p = currentPuzzle();
    $('#ans-best').text(p.best_san + ' (' + p.best_uci + ')');
    $('#ans-actual').text(p.san + ' (' + p.uci + ')');
    if (p.type === 'mate_found' || p.type === 'mate_missed') {
      $('#ans-eval').text('この対局ではこの手でチェックメイトです。');
    } else {
      $('#ans-eval').text('評価値: ' + (p.eval_before / 100).toFixed(2) + ' → ' + (p.eval_after / 100).toFixed(2));
    }
    $('#answer-box').removeClass('hidden');
  }

  function onDragStart(source, piece) {
    if (solved) return false;
    var p = currentPuzzle();
    var turnColor = p.orientation === 'white' ? 'w' : 'b';
    if (piece.search(new RegExp('^' + (turnColor === 'w' ? 'b' : 'w'))) === 0) return false;
    if (game.turn() !== turnColor) return false;
  }

  // Shared by drag-and-drop and click-to-move. Returns true if a legal chess
  // move was attempted (whether or not it matched the puzzle's answer).
  function attemptMove(from, to) {
    if (solved) return false;
    var p = currentPuzzle();
    var move = game.move({ from: from, to: to, promotion: 'q' });
    if (move === null) return false;

    var playedUci = move.from + move.to + (move.promotion || '');
    score.attempts += 1;

    var isMatePuzzle = p.type === 'mate_found' || p.type === 'mate_missed';
    if (playedUci === p.best_uci || move.san === p.best_san || (isMatePuzzle && game.in_checkmate())) {
      solved = true;
      score.correct += 1;
      $('#feedback').attr('class', 'feedback good').text('正解! ' + move.san + (isMatePuzzle ? ' でチェックメイトです。' : ' が最善手でした。'));
      showAnswer();
    } else {
      game.undo();
      $('#feedback').attr('class', 'feedback bad').text('その手 (' + move.san + ') は最善手ではありません。もう一度考えてみましょう。');
    }
    board.position(game.fen());
    saveScore();
    renderScore();
    return true;
  }

  function onDrop(source, target) {
    if (solved) return 'snapback';
    // With draggable: true, chessboard.js turns a click on a piece into a
    // zero-distance drag (mousedown starts the drag, mouseup lands on the
    // dragged clone outside #board), so no click event reaches the square.
    // Treat a drop back on the source square as a click.
    if (source === target) {
      onSquareClick(source);
      return 'snapback';
    }
    clearSelection();
    var ok = attemptMove(source, target);
    if (!ok) return 'snapback';
  }

  function onSnapEnd() {
    board.position(game.fen());
  }

  // ---- click-to-move (select a piece, then click a highlighted square) ----

  function clearSelection() {
    selectedSquare = null;
    $('#board').find('.square-55d63').removeClass('square-selected-highlight square-legal-highlight');
  }

  function selectSquare(square) {
    selectedSquare = square;
    $('#board').find('.square-' + square).addClass('square-selected-highlight');
    var moves = game.moves({ square: square, verbose: true });
    moves.forEach(function (mv) {
      $('#board').find('.square-' + mv.to).addClass('square-legal-highlight');
    });
  }

  function onSquareClick(square) {
    if (solved) return;
    var p = currentPuzzle();
    var turnColor = p.orientation === 'white' ? 'w' : 'b';

    if (selectedSquare) {
      if (square === selectedSquare) {
        clearSelection();
        return;
      }
      var piece = game.get(square);
      if (piece && piece.color === turnColor) {
        clearSelection();
        selectSquare(square);
        return;
      }
      var from = selectedSquare;
      clearSelection();
      attemptMove(from, square);
      return;
    }

    if (game.turn() !== turnColor) return;
    var p2 = game.get(square);
    if (!p2 || p2.color !== turnColor) return;
    selectSquare(square);
  }

  function resetPuzzle() {
    loadPuzzle(index);
  }

  $(function () {
    loadScore();
    renderScore();

    board = Chessboard('board', {
      draggable: true,
      position: 'start',
      pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
      onDragStart: onDragStart,
      onDrop: onDrop,
      onSnapEnd: onSnapEnd,
    });

    $('#board').on('click', '.square-55d63', function () {
      onSquareClick($(this).attr('data-square'));
    });

    $('#btn-prev').on('click', function () { loadPuzzle(index - 1); });
    $('#btn-next').on('click', function () { loadPuzzle(index + 1); });
    $('#btn-retry').on('click', resetPuzzle);
    $('#btn-answer').on('click', function () {
      clearSelection();
      solved = true;
      showAnswer();
      $('#feedback').attr('class', 'feedback').text('解答を表示しました。');
    });

    fetchJSON('data/puzzles.json').then(function (data) {
      puzzles = data.puzzles;
      $('#subtitle').text('自分の対局で実際に決めた/見逃したチェックメイトや駒得タクティクス、全' + puzzles.length + '問。盤面の駒を動かして最善手を見つけましょう。');
      $('#generated-at').text('Generated ' + data.generated_at + ' / source: ' + data.source);
      loadPuzzle(0);
    }).catch(function (err) {
      $('#feedback').attr('class', 'feedback bad').text('問題データの読み込みに失敗しました: ' + err.message);
    });
  });
})();
