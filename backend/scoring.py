from typing import Optional
from database import db

GRADE_VALUES = {"Excellent": 10, "Average": 7, "Below Average": 4, "Competent": 10, "Learnt": 7, "Not Learnt": 4, "Done": 10, "Not Done": 4, "Independent": 10, "Extend Training": 5, "Incompetent": 2}
for _i in range(1, 11):
    GRADE_VALUES[str(_i)] = _i

GRADE_PRESETS = [
    {"label": "1-10", "options": [str(i) for i in range(10, 0, -1)]},
    {"label": "Competent / Learnt / Not Learnt", "options": ["Competent", "Learnt", "Not Learnt"]},
    {"label": "Learnt / Not Learnt", "options": ["Learnt", "Not Learnt"]},
    {"label": "Excellent / Average / Below Average", "options": ["Excellent", "Average", "Below Average"]},
]

def calculate_scores(assessment: dict, targets: dict) -> dict:
    day_number = assessment.get('day_number', 1)
    # The seven graded expectations; None values (e.g. customer_service on
    # non-field days) are simply excluded from the average.
    behaviours = [assessment.get(f) for f in ['behaviour_punctuality','behaviour_engagement','behaviour_image','behaviour_coachability','behaviour_attitude','behaviour_comfort_zones','behaviour_customer_service']]
    valid_b = [b for b in behaviours if b is not None]
    behaviour_score = sum(valid_b) / len(valid_b) if valid_b else None

    skill_score = None
    if day_number >= 2 and targets:
        sa = []
        for af, tf in [('skill_intro','target_intro'),('skill_presentation','target_presentation'),('skill_short_story','target_short_story'),('skill_close','target_close'),('skill_signup','target_signup'),('skill_rehash','target_rehash')]:
            a, t = assessment.get(af), targets.get(tf, 0)
            if a is not None and t > 0:
                sa.append(min((a / t) * 10, 10))
        if sa:
            skill_score = sum(sa) / len(sa)

    kpi_score = None
    if day_number >= 3 and targets:
        ka = []
        for af, tf in [('kpi_introductions','target_introductions'),('kpi_presentations','target_presentations'),('kpi_short_stories','target_short_stories'),('kpi_closes','target_closes'),('kpi_sales','target_sales')]:
            a, t = assessment.get(af), targets.get(tf, 0)
            if a is not None and t > 0:
                ka.append((a / t) * 10)
        if ka:
            kpi_score = sum(ka) / len(ka)

    overall_score = None
    if day_number == 1 and behaviour_score is not None:
        overall_score = behaviour_score
    elif day_number == 2 and behaviour_score is not None:
        overall_score = (behaviour_score * 0.5 + skill_score * 0.5) if skill_score is not None else behaviour_score
    elif day_number >= 3 and behaviour_score is not None:
        s = [behaviour_score]
        if skill_score is not None: s.append(skill_score)
        if kpi_score is not None: s.append(kpi_score)
        overall_score = sum(s) / len(s)

    status = "Pending"
    if overall_score is not None:
        status = "S-GREEN" if overall_score >= 10 else "Green" if overall_score >= 9 else "Yellow" if overall_score >= 7 else "Red"

    return {
        'behaviour_score': round(behaviour_score, 2) if behaviour_score is not None else None,
        'skill_score': round(skill_score, 2) if skill_score is not None else None,
        'kpi_score': round(kpi_score, 2) if kpi_score is not None else None,
        'overall_score': round(overall_score, 2) if overall_score is not None else None,
        'status': status
    }

async def calculate_checklist_grade(assessment_id: str) -> Optional[float]:
    items = await db.delivery_checklist.find({"assessment_id": assessment_id}).to_list(100)
    grades: list[float] = []
    for i in items:
        g = i.get("grade")
        if not g:
            continue
        opts = i.get("grade_options") or []
        # Binary "Learnt / Not Learnt" (Orientation Day 1 & 2): "Learnt" is a PASS (10),
        # not a middling 7. The 7-for-Learnt value only applies to the 3-tier preset
        # "Competent / Learnt / Not Learnt" (Field days), where Learnt IS middle.
        if set(opts) == {"Learnt", "Not Learnt"}:
            grades.append(10.0 if g == "Learnt" else 4.0)
        elif g in GRADE_VALUES:
            grades.append(float(GRADE_VALUES[g]))
    return round(sum(grades) / len(grades), 2) if grades else None
