(function () {
  'use strict';

  var game = new Chess();
  var board = null;
  var puzzles = [];
  var index = 0;
  var solved = false;
  var score = { correct: 0, attempts: 0 };

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

    game.load(p.fen);
    board.orientation(p.orientation === 'black' ? 'black' : 'white');
    board.position(p.fen, false);

    $('#progress').text('問題 ' + (index + 1) + ' / ' + puzzles.length);
    $('#puzzle-title').text('問題 ' + (index + 1));
    $('#puzzle-meta').html(
      '対 ' + escapeHtml(p.opponent) + ' / ' + p.date + ' / ' +
      escapeHtml(p.time_class) + ' (' + escapeHtml(p.time_control) + ')<br/>' +
      escapeHtml(p.opening || '')
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
    $('#ans-eval').text(p.eval_before + ' → ' + p.eval_after + ' (悪化 ' + p.eval_drop + ')');
    $('#answer-box').removeClass('hidden');
  }

  function onDragStart(source, piece) {
    if (solved) return false;
    var p = currentPuzzle();
    var turnColor = p.orientation === 'white' ? 'w' : 'b';
    if (piece.search(new RegExp('^' + (turnColor === 'w' ? 'b' : 'w'))) === 0) return false;
    if (game.turn() !== turnColor) return false;
  }

  function onDrop(source, target) {
    if (solved) return 'snapback';
    var p = currentPuzzle();
    var move = game.move({ from: source, to: target, promotion: 'q' });
    if (move === null) return 'snapback';

    var playedUci = move.from + move.to + (move.promotion || '');
    score.attempts += 1;

    if (playedUci === p.best_uci || move.san === p.best_san) {
      solved = true;
      score.correct += 1;
      $('#feedback').attr('class', 'feedback good').text('正解! ' + move.san + ' が最善手でした。');
      showAnswer();
    } else {
      game.undo();
      $('#feedback').attr('class', 'feedback bad').text('その手 (' + move.san + ') は最善手ではありません。もう一度考えてみましょう。');
      saveScore();
      renderScore();
      return 'snapback';
    }
    saveScore();
    renderScore();
  }

  function onSnapEnd() {
    board.position(game.fen());
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

    $('#btn-prev').on('click', function () { loadPuzzle(index - 1); });
    $('#btn-next').on('click', function () { loadPuzzle(index + 1); });
    $('#btn-retry').on('click', resetPuzzle);
    $('#btn-answer').on('click', function () {
      solved = true;
      showAnswer();
      $('#feedback').attr('class', 'feedback').text('解答を表示しました。');
    });

    fetchJSON('data/puzzles.json').then(function (data) {
      puzzles = data.puzzles;
      $('#subtitle').text('直近の対局で評価値が大きく落ちた(自分のミス)局面、全' + puzzles.length + '問。盤面の駒を動かして最善手を見つけましょう。');
      $('#generated-at').text('Generated ' + data.generated_at + ' / source: ' + data.source);
      loadPuzzle(0);
    }).catch(function (err) {
      $('#feedback').attr('class', 'feedback bad').text('問題データの読み込みに失敗しました: ' + err.message);
    });
  });
})();
