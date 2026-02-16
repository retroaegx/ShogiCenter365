import React, { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import api from '@/services/apiClient';
import { useAuth } from '@/contexts/AuthContext';
import { t } from '@/i18n';
import { kifuErrorMessage } from '@/i18n/kifuErrors';
import { formatDateShort } from '@/i18n/date';

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

import KifuReplayOverlay from '@/components/kifu/KifuReplayOverlay';

import { Search, Calendar as CalendarIcon, RefreshCw, Download, Copy, Play, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

const DEFAULT_PER_PAGE = 30;

const getTimeControlOptions = () => ([
  { value: 'all', label: t("ui.components.kifu.kifusearch.kc15ccc4d") },
  { value: 'hayasashi', label: t("ui.components.kifu.kifusearch.kb5fcdc5e") },
  { value: 'hayasashi2', label: t("ui.components.kifu.kifusearch.k020b72bf") },
  { value: 'hayasashi3', label: t("ui.components.kifu.kifusearch.k2e547c45") },
  { value: '15min', label: t("ui.components.kifu.kifusearch.k69ffab6a") },
  { value: '30min', label: t("ui.components.kifu.kifusearch.k9b0e1214") },
]);


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

function winnerText(winner, reason) {
  if (winner === 'sente') return t("ui.components.kifu.kifusearch.k5eead978");
  if (winner === 'gote') return t("ui.components.kifu.kifusearch.k2cb30d4a");
  if (reason === 'jishogi_256') return t("ui.components.kifu.kifusearch.k3a533012");
  if (winner === 'draw') return t("ui.components.kifu.kifusearch.kacc1bf92");
  if (reason && ['draw', 'sennichite', 'jishogi_256', 'nyugyoku_both', 'nyugyoku_low_points_both'].includes(reason)) {
    return t("ui.components.kifu.kifusearch.kacc1bf92");
  }
  return t("ui.components.kifu.kifusearch.k0639ae30");
}
function reasonText(reason) {
  const m = {
    resign: t("ui.components.kifu.kifusearch.kd462b7f2"),
    checkmate: t("ui.components.kifu.kifusearch.k7f7c52a3"),
    timeout: t("ui.components.kifu.kifusearch.kd03cff73"),
    timeup: t("ui.components.kifu.kifusearch.kd03cff73"),
    disconnect_timeout: t("ui.components.kifu.kifusearch.k09257558"),
    disconnect_four: t("ui.components.kifu.kifusearch.k09257558"),
    illegal: t("ui.components.kifu.kifusearch.kcc055345"),
    sennichite: t("ui.components.kifu.kifusearch.k51eec1db"),
    draw: t("ui.components.kifu.kifusearch.kacc1bf92"),
    nyugyoku: t("ui.components.kifu.kifusearch.kdc7f4181"),
    nyugyoku_low_points: t("ui.components.kifu.kifusearch.k8b07b469"),
    nyugyoku_both: t("ui.components.kifu.kifusearch.kb26cc98f"),
    nyugyoku_low_points_both: t("ui.components.kifu.kifusearch.k1b32d86b"),
    jishogi_256: t("ui.components.kifu.kifusearch.k7d2b187e"),
  };
  return (reason && m[reason]) ? m[reason] : '';
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

// Mobile compact timestamp: MM/DD HH:MM (JST)
function formatToJstMdHm(isoLike) {
  const src = String(isoLike || '').trim();
  if (!src) return '';

  const hasTz = /([zZ]|[+-]\d\d:?\d\d)$/.test(src);

  let normalized = src;
  // Date はミリ秒までが安定
  if (normalized.includes('.')) {
    const [head, fracAndMaybeTz] = normalized.split('.', 2);
    const m = /^([0-9]+)(.*)$/.exec(fracAndMaybeTz || '');
    const frac = (m?.[1] || '').slice(0, 3).padEnd(3, '0');
    const rest = m?.[2] || '';
    normalized = `${head}.${frac}${rest}`;
  }
  if (!hasTz) normalized = `${normalized}Z`;

  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return '';

  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
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
  const [showReplay, setShowReplay] = useState(false);

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
        const code = res?.data?.error_code || res?.data?.error || res?.data?.code;
        const fb = res?.data?.message || res?.data?.detail || res?.data?.error || '';
        setError(kifuErrorMessage(code, fb, t("ui.components.kifu.kifusearch.kb0b3bdd7")));
      }
    } catch (e) {
      console.error('棋譜検索エラー:', e);
      setSearchResults([]);
      setSearched(true);
      setHasMore(false);
      const data = e?.response?.data;
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || data?.detail || data?.error || e?.message || '';
      setError(kifuErrorMessage(code, fb, t("ui.components.kifu.kifusearch.kb0b3bdd7")));
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
        const code = res?.data?.error_code || res?.data?.error || res?.data?.code;
        const fb = res?.data?.message || res?.data?.detail || res?.data?.error || '';
        setError(kifuErrorMessage(code, fb, t("ui.components.kifu.kifusearch.k0fad4b94")));
      }
    } catch (e) {
      console.error('棋譜取得エラー:', e);
      const data = e?.response?.data;
      const code = data?.error_code || data?.error || data?.code;
      const fb = data?.message || data?.detail || data?.error || e?.message || '';
      setError(kifuErrorMessage(code, fb, t("ui.components.kifu.kifusearch.k0fad4b94")));
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

  const openReplay = () => {
    if (!selectedKifu) return;
    // 2重 Dialog を避けるため、棋譜表示は閉じてから再生オーバーレイを開く
    setShowKifuDialog(false);
    setShowReplay(true);
  };

  return (
    <div className="kifu-viewport w-full overflow-hidden">
      <div
        className={
          `mx-auto max-w-6xl ${isMobile ? 'px-3 py-3 gap-3' : 'px-4 py-6 gap-6'} h-full flex flex-col min-w-0 min-h-0`
        }
      >
        {/* Filters */}
        {(!isMobile || mobilePane === 'filters') && (
        <Card
          className={
            `bg-white/95 supports-[backdrop-filter]:bg-white/85 backdrop-blur-md border-black/10 shadow-sm ${isMobile ? 'kifu-filters-card p-3' : ''}`
          }
        >
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t("ui.components.kifu.kifusearch.k9f0c19bf")}</CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={resetSearch} className="bg-white/90">
                <RefreshCw className="h-4 w-4 mr-2" />{
                t("ui.components.kifu.kifusearch.k97b0a1c0")
              }</Button>
              <Button size="sm" onClick={() => handleSearch(1)} className="shadow-sm">
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                {t("ui.components.kifu.kifusearch.k33d3427e")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className={`space-y-5 ${isMobile ? 'kifu-filters-body' : ''}`}>
            <div className="grid grid-cols-1 min-[769px]:grid-cols-2 gap-4">
              {/* Player1 */}
              <div className="space-y-2 min-w-0">
                <Label htmlFor="player1">{t("ui.components.kifu.kifusearch.kd93e0ea4")}</Label>
                <Input
                  id="player1"
                  value={searchParams.player1}
                  onChange={(e) => updateSearchParam('player1', e.target.value)}
                  placeholder={t("ui.components.kifu.kifusearch.k7d25d9bc")}
                  className="bg-white"
                />
              </div>

              {/* Player2 */}
              <div className="space-y-2 min-w-0">
                <Label htmlFor="player2">{t("ui.components.kifu.kifusearch.k473f208e")}</Label>
                <Input
                  id="player2"
                  value={searchParams.player2}
                  onChange={(e) => updateSearchParam('player2', e.target.value)}
                  placeholder={t("ui.components.kifu.kifusearch.k7bf235ca")}
                  className="bg-white"
                />
              </div>

              {/* Date from */}
              <div className="space-y-2">
                <Label>{t("ui.components.kifu.kifusearch.kf4850c36")}</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal bg-white">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formatDateShort(searchParams.date_from)}
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
                <Label>{t("ui.components.kifu.kifusearch.k1c649382")}</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal bg-white">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formatDateShort(searchParams.date_to)}
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
                <Label>{t("ui.components.kifu.kifusearch.kd797aaf0")}</Label>
                <Select value={searchParams.game_type} onValueChange={(v) => updateSearchParam('game_type', v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder={t("ui.components.kifu.kifusearch.kc15ccc4d")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("ui.components.kifu.kifusearch.kc15ccc4d")}</SelectItem>
                    <SelectItem value="rating">{t("ui.components.kifu.kifusearch.ke496d813")}</SelectItem>
                    <SelectItem value="free">{t("ui.components.kifu.kifusearch.k036a9f3c")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Time control */}
              <div className="space-y-2 min-[769px]:col-span-2">
                <Label>{t("ui.components.kifu.kifusearch.k21e72ec7")}</Label>
                <Select value={searchParams.time_code} onValueChange={(v) => updateSearchParam('time_code', v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder={t("ui.components.kifu.kifusearch.kc15ccc4d")} />
                  </SelectTrigger>
                  <SelectContent>
                    {getTimeControlOptions().map((o) => (
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
                <ChevronLeft className="h-4 w-4 mr-1" />{t("ui.components.kifu.kifusearch.k60a1005b")}</Button>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle className="text-base">{t("ui.components.kifu.kifusearch.k4c297620")}</CardTitle>
              <CardDescription className="text-xs">
                {!searched
                  ? t("ui.components.kifu.kifusearch.kf518c628")
                  : (searchResults.length === 0 ? t("ui.components.kifu.kifusearch.k00eb958f") : t("ui.components.kifu.kifusearch.k0eca7315", { start: shownStart, end: shownEnd }))}
              </CardDescription>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="bg-white"
                disabled={loading || currentPage <= 1}
                onClick={() => handleSearch(currentPage - 1)}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />{t("ui.components.kifu.kifusearch.k09eab561")}</Button>
              <div className="text-sm tabular-nums">{currentPage}{t("ui.components.kifu.kifusearch.kb4f80c74")}</div>
              <Button
                variant="outline"
                className="bg-white"
                disabled={loading || !hasMore}
                onClick={() => handleSearch(currentPage + 1)}
              >{t("ui.components.kifu.kifusearch.ke572295b")}<ChevronRight className="h-4 w-4 ml-1" />
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
                    {t("ui.components.kifu.kifusearch.k863ae437")}
                  </div>
                )}

                {!loading && searched && searchResults.length === 0 && (
                  <div className="text-sm text-muted-foreground py-10 text-center">{t("ui.components.kifu.kifusearch.k00eb958f")}</div>
                )}

                {searchResults.map((g) => {
                  const gid = g?.id || '';
                  const senteName = g?.players?.sente?.username || '';
                  const goteName = g?.players?.gote?.username || '';
                  const sRatingRaw = g?.players?.sente?.rating;
                  const tRatingRaw = g?.players?.gote?.rating;
                  const sRating = Number.isFinite(Number(sRatingRaw)) ? Number(sRatingRaw) : null;
                  const tRating = Number.isFinite(Number(tRatingRaw)) ? Number(tRatingRaw) : null;
                  const created = g?.created_at ? String(g.created_at) : '';
                  const createdJst = created ? formatToJstYmdHm(created) : '';
                  const createdJstCompact = created ? formatToJstMdHm(created) : '';
                  const timeDisp = g?.time_display || '';
                  const totalMoves = Number.isFinite(Number(g?.total_moves)) ? Number(g.total_moves) : 0;
                  const type = g?.game_type || '';
                  const winner = g?.winner;
                  const reason = g?.reason;

                  const createdText = isMobile ? createdJstCompact : (createdJst ? t("ui.components.kifu.kifusearch.kb24c3be3", { time: createdJst }) : "");
                  const timeText = isMobile ? timeDisp : (timeDisp ? t("ui.components.kifu.kifusearch.k15a91f8c", { time: timeDisp }) : "");
                  const movesText = totalMoves > 0
                    ? (isMobile ? t("ui.components.kifu.kifusearch.k48c89179", { moves: totalMoves }) : t("ui.components.kifu.kifusearch.k1d826ef1", { moves: totalMoves }) )
                    : '';

                  const ratingClass = isMobile
                    ? 'shrink-0 text-[10px] leading-none text-muted-foreground font-normal align-baseline tracking-tight'
                    : 'shrink-0 text-xs text-muted-foreground font-normal';
                  const sRatingNode = (senteName && sRating && sRating > 0) ? (
                    <span className={ratingClass}>（{sRating}）</span>
                  ) : null;
                  const tRatingNode = (goteName && tRating && tRating > 0) ? (
                    <span className={ratingClass}>（{tRating}）</span>
                  ) : null;


                  const vsClass = isMobile
                    ? 'shrink-0 px-1 text-[11px] text-muted-foreground'
                    : 'shrink-0 px-1 text-sm text-muted-foreground';

                  // PC: なるべく省略しない（足りないときだけ折り返す）
                  const desktopTitleNode = (
                    <div className="min-w-0 flex flex-wrap items-baseline gap-x-1 gap-y-0">
                      <span className="font-medium break-all">{senteName}</span>
                      {sRatingNode}
                      <span className={vsClass}>vs</span>
                      <span className="font-medium break-all">{goteName}</span>
                      {tRatingNode}
                    </div>
                  );

                  // スマホ: 右見切れ対策で 2 行に分け、名前だけ省略（レーティングは保持）
                  const mobileTitleNode = (
                    <div className="min-w-0 flex flex-col">
                      <div className="min-w-0 flex items-baseline gap-1">
                        <span className="font-medium truncate">{senteName}</span>
                        {sRatingNode}
                        <span className={vsClass}>vs</span>
                      </div>
                      <div className="min-w-0 flex items-baseline gap-1">
                        <span className="font-medium truncate">{goteName}</span>
                        {tRatingNode}
                      </div>
                    </div>
                  );

                  const titleNode = isMobile ? mobileTitleNode : desktopTitleNode;


                  return (
                    <button
                      key={gid}
                      type="button"
                      onClick={() => gid && fetchKifuDetail(gid)}
                      className="w-full text-left rounded-xl border border-black/10 bg-white hover:bg-slate-50 transition px-4 py-2 shadow-sm"
                    >
                      {!isMobile ? (
                        <div className="flex items-center justify-between gap-3 min-w-0">
                          <div className="flex items-start gap-3 min-w-0">
                            <div className="min-w-0">
                              {titleNode}
                            </div>
                            <div className="text-xs text-muted-foreground truncate min-w-0">
                              {createdText}
                              {createdText && timeText ? t('ui.components.kifu.kifusearch.kf0916fb0') : ''}
                              {timeText}
                              {(createdText || timeText) && movesText ? t('ui.components.kifu.kifusearch.kf0916fb0') : ''}
                              {movesText}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
                            <Badge variant="outline" className="bg-white">
                              {type === "free" ? t("ui.components.kifu.kifusearch.k036a9f3c") : t("ui.components.kifu.kifusearch.kbfb236f4")}
                            </Badge>
                            <div className="text-xs">
                              <span className="font-medium">{winnerText(winner, reason)}</span>
                              {(reason && reason !== 'jishogi_256') ? <span className="text-muted-foreground">（{reasonText(reason)}）</span> : null}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <div className="min-w-0 flex-1">
                              {titleNode}
                            </div>
                            <Badge variant="outline" className="bg-white shrink-0">
                              {type === "free" ? t("ui.components.kifu.kifusearch.k036a9f3c") : t("ui.components.kifu.kifusearch.kbfb236f4")}
                            </Badge>
                          </div>

                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <div className="text-xs text-muted-foreground truncate min-w-0 flex-1">
                              {createdText}
                              {createdText && timeText ? t('ui.components.kifu.kifusearch.kf0916fb0') : ''}
                              {timeText}
                              {(createdText || timeText) && movesText ? t('ui.components.kifu.kifusearch.kf0916fb0') : ''}
                              {movesText}
                            </div>

                            <div className="text-xs shrink-0 whitespace-nowrap">
                              <span className="font-medium">{winnerText(winner, reason)}</span>
                              {(reason && reason !== 'jishogi_256') ? <span className="text-muted-foreground">（{reasonText(reason)}）</span> : null}
                            </div>
                          </div>
                        </div>
                      )}
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
              <DialogTitle>{t("ui.components.kifu.kifusearch.k2077873e")}</DialogTitle>
              <DialogDescription className="text-xs">
                {selectedKifu?.game?.players?.sente?.username || ''} vs {selectedKifu?.game?.players?.gote?.username || ''}
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={openReplay}
                className="bg-white"
                disabled={!selectedKifu}
              >
                <Play className="h-4 w-4 mr-2" />{t("ui.components.kifu.kifusearch.k66a340bc")}</Button>
              <Button
                variant="outline"
                onClick={() => copyKifu(selectedKifu?.kif_text)}
                className="bg-white"
              >
                <Copy className="h-4 w-4 mr-2" />{t("ui.components.kifu.kifusearch.ke94c2107")}</Button>
              <Button
                variant="outline"
                onClick={() => downloadKifu(selectedKifu?.kif_text, selectedKifu?.game?.id || 'game')}
                className="bg-white"
              >
                <Download className="h-4 w-4 mr-2" />{t("ui.components.kifu.kifusearch.kbc3a8587")}</Button>
            </div>

            <div className="rounded-xl border bg-slate-50 p-3">
              <pre className="text-xs whitespace-pre-wrap break-words max-h-[55vh] overflow-auto">
                {selectedKifu?.kif_text || ''}
              </pre>
            </div>
          </DialogContent>
        </Dialog>

        <KifuReplayOverlay
          open={showReplay}
          onOpenChange={setShowReplay}
          kifu={selectedKifu}
        />
      </div>
    </div>
  );
}
