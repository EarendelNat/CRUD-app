// The race track.
//
// Positions are drawn on an ABSOLUTE scale -- a fixed number of pixels per
// thousand steps -- so the gaps you see are the real gaps. That means the
// leader is often far off the right edge, which is the point: it should feel
// like a distance. Two things stop that becoming disorienting:
//
//   * a fixed left gutter of names, so a runner scrolled out of view still has
//     a visible lane
//   * a minimap showing the whole track at once, with a draggable viewport
//
// A compressed scale would keep everyone on screen but would quietly lie about
// the distances, so we don't use one.

const PX_PER_1K = 88;
const LEFT_PAD = 30; // breathing room so a runner on 0 steps isn't clipped
const RIGHT_PAD = 130; // room for the leader's step-count chip

const pxFor = (steps) => LEFT_PAD + (steps / 1000) * PX_PER_1K;

/** A stable colour per member, for the minimap dots. */
function hueFor(id) {
  return (id * 47) % 360;
}

const shortSteps = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);

export class Track {
  constructor({ gutter, scroller, inner, minimap, viewport }) {
    this.gutter = gutter;
    this.scroller = scroller;
    this.inner = inner;
    this.minimap = minimap;
    this.viewport = viewport;

    this.trackWidth = 0;

    this.scroller.addEventListener('scroll', () => this.syncViewport(), { passive: true });
    window.addEventListener('resize', () => this.syncViewport());

    // Click or drag anywhere on the minimap to jump the track there.
    const jump = (event) => {
      const bounds = this.minimap.getBoundingClientRect();
      const ratio = (event.clientX - bounds.left) / bounds.width;
      const target = ratio * this.trackWidth - this.scroller.clientWidth / 2;
      this.scroller.scrollLeft = Math.max(0, target);
    };
    this.minimap.addEventListener('pointerdown', (event) => {
      jump(event);
      const move = (e) => jump(e);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /** Keep the minimap's viewport box in step with the real scroll position. */
  syncViewport() {
    if (!this.trackWidth) return;
    const visible = Math.min(1, this.scroller.clientWidth / this.trackWidth);
    const offset = this.scroller.scrollLeft / this.trackWidth;
    this.viewport.style.width = `${visible * 100}%`;
    this.viewport.style.left = `${Math.min(1 - visible, offset) * 100}%`;
  }

  render(week) {
    const { members, milestones } = week;
    const me = members.find((m) => m.isMe);

    // The track runs past the last milestone and past the leader, so there is
    // always a little road ahead of whoever is winning.
    const furthest = Math.max(
      week.maxSteps,
      milestones.at(-1) ?? 0,
      me?.weeklyGoal ?? 0,
      me?.paceTarget ?? 0
    );
    this.trackWidth = pxFor(furthest) + RIGHT_PAD;

    this.renderGutter(members);
    this.renderLanes(week, me);
    this.renderMinimap(members);

    // Wait for layout before measuring the viewport box.
    requestAnimationFrame(() => this.syncViewport());
  }

  renderGutter(members) {
    this.gutter.replaceChildren(
      ...members.map((member) => {
        const row = document.createElement('div');
        row.className = 'gutter-row';
        if (member.isMe) row.classList.add('gutter-row--me');
        if (member.isGhost) row.classList.add('gutter-row--ghost');

        const rank = document.createElement('span');
        rank.className = 'gutter-row__rank';
        rank.textContent = member.rank;

        const avatar = document.createElement('span');
        avatar.className = 'gutter-row__avatar';
        avatar.textContent = member.avatar;

        const name = document.createElement('span');
        name.className = 'gutter-row__name';
        name.textContent = member.isMe ? 'You' : member.name;
        name.title = member.name;

        row.append(rank, avatar, name);
        return row;
      })
    );
  }

  renderLanes(week, me) {
    this.inner.style.width = `${this.trackWidth}px`;

    const parts = [];

    // One lane strip per member, in rank order.
    for (let i = 0; i < week.members.length; i++) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      parts.push(lane);
    }

    // Milestone guides, drawn over every lane.
    for (const milestone of week.milestones) {
      const guide = document.createElement('div');
      guide.className = 'guide';
      guide.style.left = `${pxFor(milestone)}px`;

      const label = document.createElement('span');
      label.className = 'guide__label';
      label.textContent = shortSteps(milestone);
      guide.append(label);
      parts.push(guide);
    }

    if (me) {
      // Where YOU should be by today to hit your own weekly goal. This is the
      // feature that gives the back half of the field something to race.
      const pace = document.createElement('div');
      pace.className = 'guide guide--pace';
      pace.style.left = `${pxFor(me.paceTarget)}px`;
      const paceLabel = document.createElement('span');
      paceLabel.className = 'guide__label';
      paceLabel.textContent = `Your ${week.isCurrentWeek ? 'target today' : 'week target'}`;
      pace.append(paceLabel);
      parts.push(pace);

      // Your finish line: the full weekly goal.
      const goal = document.createElement('div');
      goal.className = 'guide guide--goal';
      goal.style.left = `${pxFor(me.weeklyGoal)}px`;
      const goalLabel = document.createElement('span');
      goalLabel.className = 'guide__label';
      goalLabel.textContent = `🏁 Your goal ${shortSteps(me.weeklyGoal)}`;
      goal.append(goalLabel);
      parts.push(goal);
    }

    // Runners, positioned inside their lane by index.
    week.members.forEach((member, index) => {
      const runner = document.createElement('div');
      runner.className = 'runner';
      if (member.isMe) runner.classList.add('runner--me');
      if (member.isGhost) runner.classList.add('runner--ghost');
      runner.style.left = `${pxFor(member.total)}px`;
      // Centre the runner vertically in their own lane.
      runner.style.top = `calc(var(--lane-h) * ${index} + var(--lane-h) / 2)`;

      const avatar = document.createElement('div');
      avatar.className = 'runner__avatar';
      avatar.textContent = member.avatar;

      const chip = document.createElement('div');
      chip.className = 'runner__chip';
      chip.textContent = member.total.toLocaleString('en-US');

      runner.append(avatar, chip);

      if (member.isGhost) {
        const stale = document.createElement('span');
        stale.className = 'runner__stale';
        stale.textContent = member.lastLoggedDay
          ? `last: ${member.lastLoggedDay}`
          : 'not logged';
        runner.append(stale);
        runner.title = `${member.name} hasn't logged today yet`;
      }

      if (member.isMe) this.myRunner = runner;
      parts.push(runner);
    });

    this.inner.replaceChildren(...parts);
  }

  renderMinimap(members) {
    const dots = members.map((member) => {
      const dot = document.createElement('div');
      dot.className = 'minimap__dot';
      if (member.isMe) dot.classList.add('minimap__dot--me');
      dot.style.left = `${(pxFor(member.total) / this.trackWidth) * 100}%`;
      // Stagger the dots vertically so ten of them don't stack into one blob.
      dot.style.top = `${25 + ((member.rank - 1) % 4) * 17}%`;
      dot.style.background = member.isGhost
        ? 'var(--faint)'
        : `hsl(${hueFor(member.id)} 68% 52%)`;
      dot.title = `${member.name}: ${member.total.toLocaleString('en-US')}`;
      return dot;
    });

    this.minimap.replaceChildren(this.viewport, ...dots);
  }

  /** Scroll so the viewer's own runner sits in the middle of the track view. */
  scrollToMe(smooth = true) {
    if (!this.myRunner) return;
    const target = this.myRunner.offsetLeft - this.scroller.clientWidth / 2;
    this.scroller.scrollTo({
      left: Math.max(0, target),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
}
