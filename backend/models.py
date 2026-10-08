from pydantic import BaseModel
from typing import List, Optional

# ==================== AUTH MODELS ====================

class LoginRequest(BaseModel):
    email: str
    password: str

class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str
    office_id: Optional[str] = None
    leader_id: Optional[str] = None

class CreateLeaderRequest(BaseModel):
    email: str
    password: str
    name: str

class PromoteRequest(BaseModel):
    role: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UpdateUserNameRequest(BaseModel):
    name: str

class UpdateUserEmailRequest(BaseModel):
    email: str

class UpdatePhoneRequest(BaseModel):
    phone: str


class ProfileImageRequest(BaseModel):
    image: str

class OfficeCreate(BaseModel):
    name: str
    city: str
    state: str

# ==================== BUSINESS MODELS ====================

class NewHireCreate(BaseModel):
    name: str
    leader: str = ""
    leader_id: Optional[str] = None
    start_date: str
    campaign: str = ""
    notes: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None

class NewHire(BaseModel):
    id: str
    name: str
    leader: str
    start_date: str
    campaign: str = ""
    phase: str = "Week 1"
    current_day: int = 1
    current_status: str = "In Progress"
    final_outcome: Optional[str] = None
    active: bool = True
    created_at: str
    trainee_user_id: Optional[str] = None
    office_id: Optional[str] = None

class DailyAssessmentUpdate(BaseModel):
    # The seven graded expectations (aligned with the product-training
    # slides): punctuality, engagement ("100% Effort"), image ("Professional
    # Image"), coachability ("Student Mentality"), attitude ("Positive
    # Attitude"), comfort_zones ("Breaking Comfort Zones") and
    # customer_service ("Customer Service", field days only).
    behaviour_punctuality: Optional[float] = None
    behaviour_engagement: Optional[float] = None
    behaviour_image: Optional[float] = None
    behaviour_coachability: Optional[float] = None
    behaviour_attitude: Optional[float] = None
    behaviour_comfort_zones: Optional[float] = None
    behaviour_customer_service: Optional[float] = None
    skill_intro: Optional[float] = None
    skill_presentation: Optional[float] = None
    skill_short_story: Optional[float] = None
    skill_close: Optional[float] = None
    skill_signup: Optional[float] = None
    skill_rehash: Optional[float] = None
    kpi_introductions: Optional[int] = None
    kpi_presentations: Optional[int] = None
    kpi_short_stories: Optional[int] = None
    kpi_closes: Optional[int] = None
    kpi_sales: Optional[int] = None
    leader_assisted_sales: Optional[int] = None
    coaching_actions: Optional[str] = None
    biggest_weakness: Optional[str] = None
    focus_tomorrow: Optional[str] = None
    leader_notes: Optional[str] = None
    completed: bool = False

class DailyAssessment(BaseModel):
    id: str
    new_hire_id: str
    new_hire_name: str
    day_number: int
    assessment_date: Optional[str] = None
    completed: bool = False
    completed_by: Optional[str] = None
    behaviour_punctuality: Optional[float] = None
    behaviour_engagement: Optional[float] = None
    behaviour_image: Optional[float] = None
    behaviour_coachability: Optional[float] = None
    behaviour_attitude: Optional[float] = None
    behaviour_comfort_zones: Optional[float] = None
    behaviour_customer_service: Optional[float] = None
    skill_intro: Optional[float] = None
    skill_presentation: Optional[float] = None
    skill_short_story: Optional[float] = None
    skill_close: Optional[float] = None
    skill_signup: Optional[float] = None
    skill_rehash: Optional[float] = None
    kpi_introductions: Optional[int] = None
    kpi_presentations: Optional[int] = None
    kpi_short_stories: Optional[int] = None
    kpi_closes: Optional[int] = None
    kpi_sales: Optional[int] = None
    leader_assisted_sales: Optional[int] = None
    behaviour_score: Optional[float] = None
    skill_score: Optional[float] = None
    kpi_score: Optional[float] = None
    checklist_grade_score: Optional[float] = None
    overall_score: Optional[float] = None
    status: str = "Pending"
    coaching_actions: Optional[str] = None
    biggest_weakness: Optional[str] = None
    focus_tomorrow: Optional[str] = None
    leader_notes: Optional[str] = None

class DeliveryChecklistUpdate(BaseModel):
    taught: Optional[bool] = None
    outcome_achieved: Optional[bool] = None
    confidence_level: Optional[str] = None
    grade: Optional[str] = None
    notes: Optional[str] = None

class DeliveryChecklist(BaseModel):
    id: str
    assessment_id: str
    manual_item_id: str
    topic: str
    category: str
    confidence_expected: str = "Understand"
    taught: bool = False
    outcome_achieved: bool = False
    confidence_level: str = "Not yet"
    grade: Optional[str] = None
    grade_options: List[str] = []
    notes: Optional[str] = None
    # Enriched on-the-fly from training_manual on GET so the assessment screen
    # can show "What to teach" + "Expected outcome" inline when the topic is
    # tapped (no DB migration needed; stale rows just return None).
    what_good_looks_like: Optional[str] = None
    expected_outcome: Optional[str] = None

class ReassignLeaderRequest(BaseModel):
    leader: str

class TargetUpdate(BaseModel):
    target_intro: Optional[int] = None
    target_presentation: Optional[int] = None
    target_short_story: Optional[int] = None
    target_close: Optional[int] = None
    target_signup: Optional[int] = None
    target_rehash: Optional[int] = None
    target_introductions: Optional[int] = None
    target_presentations: Optional[int] = None
    target_short_stories: Optional[int] = None
    target_closes: Optional[int] = None
    target_sales: Optional[int] = None
    leader_assisted_sales_target: Optional[int] = None
    day_objective: Optional[str] = None
    what_good_looks_like: Optional[list] = None
    what_great_looks_like: Optional[list] = None
    hire_what_good_looks_like: Optional[list] = None
    hire_what_great_looks_like: Optional[list] = None

class ManualItemUpdate(BaseModel):
    topic: Optional[str] = None
    what_good_looks_like: Optional[str] = None
    expected_outcome: Optional[str] = None
    confidence_expected: Optional[str] = None
    category: Optional[str] = None
    grade_options: Optional[list] = None

class ManualItemCreate(BaseModel):
    day_number: int
    category: str
    topic: str
    what_good_looks_like: str
    expected_outcome: str
    grade_options: list = []

class ReorderRequest(BaseModel):
    ordered_sequences: list

class BulkGradeUpdate(BaseModel):
    items: list
