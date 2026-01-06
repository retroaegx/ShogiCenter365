import React, { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

import api from '@/services/apiClient';
import { useAuth } from '@/contexts/AuthContext';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

import { Search, Calendar as CalendarIcon, RefreshCw, Download, Copy, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

const DEFAULT_PER_PAGE = 30;

const TIME_CONTROL_OPTIONS = [
  { value: 'all', label: 'すべて' },
  { value: 'hayasashi', label: '早指（1分 + 30秒）' },
  { value: 'hayasashi2', label: '早指2（猶予1分 + 30秒秒読み）' },
  { value: 'hayasashi3', label: '早指3（猶予2分 + 30秒秒読み）' },
  { value: '15min', label: '15分 + 60秒' },
  { value: '30min', label: '30分 + 60秒' },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 768px)');

    const onChange = (e) => setIsMobile(Boolean(e?.matches));

    // 初期反映
    setIsMobile(mq.matches);

    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);

    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  return isMobile;
}

function jpWinnerText(winner) {
  if (winner === 'sente') return '先手勝ち';
  if (winner === 'gote') return '後手勝ち';
  return '未確定';
}
function jpReasonText(reason) {
  const m = {
    resign: '投了',
    timeout: '時間切れ',
    disconnect_timeout: '切断',
    disconnect_four: '切断',
    illegal: '反則',
    draw: '引き分け',
  };
  return (reason && m[reason]) ? m[reason] : (reason || '');
}

function formatToJstYmdHm(isoLike) {
  const src = String(isoLike || '').trim();
  if (!src) return '';

  // API が "2025-12-25T01:45:17.888000" のように tz 無し・マイクロ秒付きで返すことがある。
  // tz が無い場合は UTC とみなして JST 表示にする（画面要件）。
  const hasTz = /([zZ]|[+-]\d\d:?\d\d)$/.test(src);

  let normalized = src;
  // ミリ秒までに丸める（Date は 3 桁までしか安定しない）
  if (normalized.includes('.')) {
    const [head, fracAndMaybeTz] = normalized.split('.', 2);
    const m = /^([0-9]+)(.*)$/.exec(fracAndMaybeTz || '');
    const frac = (m?.[1] || '').slice(0, 3).padEnd(3, '0');
    const rest = m?.[2] || '';
    normalized = `${head}.${frac}${rest}`;
  }
  if (!hasTz) {
    normalized = `${normalized}Z`;
  }

  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return src;

  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

export default function KifuSearch() {
  const { user } = useAuth();
  const isMobile = useIsMobile();

  // スマホでは「検索前＝条件」「検索後＝結果」を1画面にする
  const [mobilePane, setMobilePane] = useState('filters');

  const [searchParams, setSearchParams] = useState(() => ({
    player1: user?.username || '',
    player2: '',
    date_from: new Date(new Date().setFullYear(new Date().getFullYear() - 1)),
    date_to: new Date(),
    game_type: 'all', // rating/free
    result: 'all',    // sente/gote/draw
    time_code: 'all', // hayasashi/15min...
  }));

  const [searchResults, setSearchResults] = useState([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    // 画面幅が変わってスマホになったときの初期表示
    if (isMobile) {
      setMobilePane(searched ? 'results' : 'filters');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [resultsPerPage] = useState(DEFAULT_PER_PAGE);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedKifu, setSelectedKifu] = useState(null);
  const [showKifuDialog, setShowKifuDialog] = useState(false);

  // user が遅れて来た場合の初期反映
  useEffect(() => {
    if (user?.username && !searchParams.player1) {
      setSearchParams((p) => ({ ...p, player1: user.username }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.username]);

  const shownStart = useMemo(() => (
    searchResults.length > 0 ? ((currentPage - 1) * resultsPerPage + 1) : 0
  ), [searchResults.length, currentPage, resultsPerPage]);
  const shownEnd = useMemo(() => (
    (currentPage - 1) * resultsPerPage + searchResults.length
  ), [searchResults.length, currentPage, resultsPerPage]);

  const updateSearchParam = (key, value) => {
    setSearchParams((p) => ({ ...p, [key]: value }));
  };

  const resetSearch = () => {
    const now = new Date();
    setSearchParams({
      player1: user?.username || '',
      player2: '',
      date_from: new Date(now.setFullYear(now.getFullYear() - 1)),
      date_to: new Date(),
      game_type: 'all',
      result: 'all',
      time_code: 'all',
    });
    setSearchResults([]);
    setSearched(false);
    setMobilePane('filters');
    setHasMore(false);
    setCurrentPage(1);
    setError('');
  };

  const handleSearch = async (page = 1) => {
    setLoading(true);
    setError('');
    setCurrentPage(page);
    if (isMobile) setMobilePane('results');

    try {
      const params = {
        player1: searchParams.player1?.trim() || null,
        player2: searchParams.player2?.trim() || null,
        date_from: format(searchParams.date_from, 'yyyy-MM-dd'),
        date_to: format(searchParams.date_to, 'yyyy-MM-dd'),
        game_type: searchParams.game_type === 'all' ? null : searchParams.game_type,
        result: searchParams.result === 'all' ? null : searchParams.result,
        time_code: searchParams.time_code === 'all' ? null : searchParams.time_code,
        page,
        per_page: resultsPerPage,
      };

      Object.keys(params).forEach((k) => {
        if (params[k] == null || params[k] === '') delete params[k];
      });

      // apiClient は baseURL を /api にしているので、ここでは相対パスで叩く
      // （本番ドメインで :5000 などを誤って参照しないため）
      const res = await api.get('/kifu/search', { params });
      if (res?.data?.success) {
        setSearchResults(Array.isArray(res.data.games) ? res.data.games : []);
        setSearched(true);
        setHasMore(Boolean(res.data.has_more));
      } else {
        setSearchResults([]);
        setSearched(true);
        setHasMore(false);
        setError(res?.data?.message || '検索に失敗しました');
      }
    } catch (e) {
      console.error('棋譜検索エラー:', e);
      setSearchResults([]);
      setSearched(true);
      setHasMore(false);
      setError('検索に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const fetchKifuDetail = async (gameId) => {
    try {
      const res = await api.get(`/kifu/${gameId}`);
      if (res?.data?.success) {
        setSelectedKifu(res.data.kifu);
        setShowKifuDialog(true);
      } else {
        setError(res?.data?.message || '棋譜の取得に失敗しました');
      }
    } catch (e) {
      console.error('棋譜取得エラー:', e);
      setError('棋譜の取得に失敗しました');
    }
  };

  const copyKifu = async (kifText) => {
    try {
      await navigator.clipboard.writeText(String(kifText || ''));
    } catch (e) {
      console.error('copy failed', e);
    }
  };

  const downloadKifu = (kifText, gameId) => {
    try {
      const blob = new Blob([String(kifText || '')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shogi_game_${gameId}.kif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('download failed', e);
    }
  };

  return (
    <div className="kifu-viewport w-full overflow-hidden">
      <div className="mx-auto max-w-6xl px-4 py-6 h-full flex flex-col gap-6 min-w-0 min-h-0">
        {/* Filters */}
        {(!isMobile || mobilePane === 'filters') && (
        <Card className="bg-white/95 supports-[backdrop-filter]:bg-white/85 backdrop-blur-md border-black/10 shadow-sm">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">棋譜検索</CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={resetSearch} className="bg-white/90">
                <RefreshCw className="h-4 w-4 mr-2" />
                リセット
              </Button>
              <Button size="sm" onClick={() => handleSearch(1)} className="shadow-sm">
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                検索
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 min-[769px]:grid-cols-2 gap-4">
              {/* Player1 */}
              <div className="space-y-2 min-w-0">
                <Label htmlFor="player1">対局者1</Label>
                <Input
                  id="player1"
                  value={searchParams.player1}
                  onChange={(e) => updateSearchParam('player1', e.target.value)}
                  placeholder="ユーザー名"
                  className="bg-white"
                />
              </div>

              {/* Player2 */}
              <div className="space-y-2 min-w-0">
                <Label htmlFor="player2">対局者2</Label>
                <Input
                  id="player2"
                  value={searchParams.player2}
                  onChange={(e) => updateSearchParam('player2', e.target.value)}
                  placeholder="ユーザー名（任意）"
                  className="bg-white"
                />
              </div>

              {/* Date from */}
              <div className="space-y-2">
                <Label>開始日</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal bg-white">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {format(searchParams.date_from, 'yyyy年MM月dd日', { locale: ja })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={searchParams.date_from}
                      onSelect={(d) => d && updateSearchParam('date_from', d)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Date to */}
              <div className="space-y-2">
                <Label>終了日</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal bg-white">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {format(searchParams.date_to, 'yyyy年MM月dd日', { locale: ja })}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={searchParams.date_to}
                      onSelect={(d) => d && updateSearchParam('date_to', d)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Game type */}
              <div className="space-y-2">
                <Label>対局タイプ</Label>
                <Select value={searchParams.game_type} onValueChange={(v) => updateSearchParam('game_type', v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="すべて" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">すべて</SelectItem>
                    <SelectItem value="rating">レーティング</SelectItem>
                    <SelectItem value="free">自由対局</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Result */}
              <div className="space-y-2">
                <Label>結果</Label>
                <Select value={searchParams.result} onValueChange={(v) => updateSearchParam('result', v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="すべて" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">すべて</SelectItem>
                    <SelectItem value="sente">先手勝ち</SelectItem>
                    <SelectItem value="gote">後手勝ち</SelectItem>
                    <SelectItem value="draw">引き分け</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Time control */}
              <div className="space-y-2 min-[769px]:col-span-2">
                <Label>持ち時間</Label>
                <Select value={searchParams.time_code} onValueChange={(v) => updateSearchParam('time_code', v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="すべて" />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_CONTROL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription className="break-words">{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
        )}

        {/* Results */}
        {(!isMobile || mobilePane === 'results') && (
        <Card className="bg-white/95 supports-[backdrop-filter]:bg-white/85 backdrop-blur-md border-black/10 shadow-sm flex flex-col flex-1 min-h-0">
          <CardHeader className="flex flex-col gap-2">
            <div className="min-[769px]:hidden">
              <Button
                variant="outline"
                size="sm"
                className="bg-white"
                onClick={() => setMobilePane('filters')}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                戻る
              </Button>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="text-base">検索結果</CardTitle>
              <CardDescription className="text-xs">
                {!searched
                  ? 'まだ検索していません'
                  : (searchResults.length === 0 ? '結果が見つかりませんでした' : `${shownStart}〜${shownEnd}件を表示`)}
              </CardDescription>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="bg-white"
                disabled={loading || currentPage <= 1}
                onClick={() => handleSearch(currentPage - 1)}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                前へ
              </Button>
              <div className="text-sm tabular-nums">{currentPage}ページ</div>
              <Button
                variant="outline"
                className="bg-white"
                disabled={loading || !hasMore}
                onClick={() => handleSearch(currentPage + 1)}
              >
                次へ
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
            </div>
          </CardHeader>

          <CardContent className="flex-1 min-h-0">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-2">
                {loading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    検索中…
                  </div>
                )}

                {!loading && searched && searchResults.length === 0 && (
                  <div className="text-sm text-muted-foreground py-10 text-center">結果が見つかりませんでした</div>
                )}

                {searchResults.map((g) => {
                  const gid = g?.id || '';
                  const s = g?.players?.sente?.username || '';
                  const t = g?.players?.gote?.username || '';
                  const created = g?.created_at ? String(g.created_at) : '';
                  const createdJst = created ? formatToJstYmdHm(created) : '';
                  const timeDisp = g?.time_display || '';
                  const type = g?.game_type || '';
                  const winner = g?.winner;
                  const reason = g?.reason;

                  return (
                    <button
                      key={gid}
                      type="button"
                      onClick={() => gid && fetchKifuDetail(gid)}
                      className="w-full text-left rounded-xl border border-black/10 bg-white hover:bg-slate-50 transition px-4 py-2 shadow-sm overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-3 min-w-0">
                        <div className="flex items-center gap-3 min-w-0 whitespace-nowrap overflow-hidden">
                          <div className="font-medium truncate">{s} vs {t}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {createdJst ? `開始: ${createdJst}` : ''}
                            {createdJst && timeDisp ? ' ・ ' : ''}
                            {timeDisp ? `持ち時間: ${timeDisp}` : ''}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
                          <Badge variant="outline" className="bg-white">
                            {type === 'free' ? '自由対局' : 'レート'}
                          </Badge>
                          <div className="text-xs">
                            <span className="font-medium">{jpWinnerText(winner)}</span>
                            {reason ? <span className="text-muted-foreground">（{jpReasonText(reason)}）</span> : null}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
        )}

        {/* KIF Dialog */}
        <Dialog open={showKifuDialog} onOpenChange={setShowKifuDialog}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>棋譜</DialogTitle>
              <DialogDescription className="text-xs">
                {selectedKifu?.game?.players?.sente?.username || ''} vs {selectedKifu?.game?.players?.gote?.username || ''}
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => copyKifu(selectedKifu?.kif_text)}
                className="bg-white"
              >
                <Copy className="h-4 w-4 mr-2" />
                コピー
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadKifu(selectedKifu?.kif_text, selectedKifu?.game?.id || 'game')}
                className="bg-white"
              >
                <Download className="h-4 w-4 mr-2" />
                ダウンロード
              </Button>
            </div>

            <div className="rounded-xl border bg-slate-50 p-3">
              <pre className="text-xs whitespace-pre-wrap break-words max-h-[55vh] overflow-auto">
                {selectedKifu?.kif_text || ''}
              </pre>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
