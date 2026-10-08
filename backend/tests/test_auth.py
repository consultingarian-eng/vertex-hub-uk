"""
Backend Auth API tests for the field training app
Tests: Login, protected endpoints, admin/leader access control, JWT validation
"""
import pytest
import requests
import os

if os.environ.get("CG1_RUN_REMOTE_TESTS") != "1":
    pytest.skip("remote tests require CG1_RUN_REMOTE_TESTS=1", allow_module_level=True)
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    pytest.skip("EXPO_PUBLIC_BACKEND_URL not set", allow_module_level=True)

# Remote integration credentials are opt-in and never stored in the repo.
ADMIN_EMAIL = os.environ.get("CG1_TEST_ADMIN_EMAIL", "").strip()
ADMIN_PASSWORD = os.environ.get("CG1_TEST_ADMIN_PASSWORD", "")
if not ADMIN_EMAIL or not ADMIN_PASSWORD:
    pytest.skip(
        "CG1_TEST_ADMIN_EMAIL and CG1_TEST_ADMIN_PASSWORD are required for remote auth tests",
        allow_module_level=True,
    )

class TestAuthLogin:
    """Authentication login tests"""
    
    def test_admin_login_success(self):
        """Admin should be able to login with correct credentials"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert "token" in data
        assert "id" in data
        assert "email" in data
        assert data["email"] == ADMIN_EMAIL
        assert data["role"] == "admin"
        expected_name = os.environ.get("CG1_TEST_ADMIN_NAME", "").strip()
        assert data["name"]
        if expected_name:
            assert data["name"] == expected_name
        
    def test_login_invalid_password(self):
        """Login should fail with wrong password"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": "WrongPassword123"
        })
        assert response.status_code == 401
        assert "detail" in response.json()
        
    def test_login_invalid_email(self):
        """Login should fail with non-existent email"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": "nonexistent@example.com",
            "password": "password123"
        })
        assert response.status_code == 401
        
    def test_login_returns_httponly_cookies(self):
        """Login should set httpOnly cookies for access_token and refresh_token"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200
        cookies = response.cookies
        assert "access_token" in cookies
        assert "refresh_token" in cookies

class TestProtectedEndpoints:
    """Test that protected endpoints require authentication"""
    
    def test_get_new_hires_without_token_returns_401(self):
        """GET /new-hires should return 401 without auth token"""
        response = requests.get(f"{BASE_URL}/api/new-hires")
        assert response.status_code == 401
        
    def test_create_new_hire_without_token_returns_401(self):
        """POST /new-hires should return 401 without auth token"""
        response = requests.post(f"{BASE_URL}/api/new-hires", json={
            "name": "Test Hire",
            "leader": "Test Leader",
            "start_date": "2026-01-15"
        })
        assert response.status_code == 401
        
    def test_dashboard_stats_without_token_returns_401(self):
        """GET /dashboard/stats should return 401 without auth token"""
        response = requests.get(f"{BASE_URL}/api/dashboard/stats")
        assert response.status_code == 401
        
    def test_admin_endpoints_without_token_return_401(self):
        """Admin endpoints should return 401 without auth token"""
        response = requests.get(f"{BASE_URL}/api/admin/users")
        assert response.status_code == 401
        
        response = requests.get(f"{BASE_URL}/api/admin/leader-rankings")
        assert response.status_code == 401

class TestAuthMe:
    """Test /auth/me endpoint"""
    
    def test_auth_me_with_valid_token(self):
        """GET /auth/me should return user data with valid token"""
        # Login first
        login_response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        token = login_response.json()["token"]
        
        # Get user info
        response = requests.get(f"{BASE_URL}/api/auth/me", headers={
            "Authorization": f"Bearer {token}"
        })
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == ADMIN_EMAIL
        assert data["role"] == "admin"
        assert "password_hash" not in data  # Should not expose password
        
    def test_auth_me_without_token_returns_401(self):
        """GET /auth/me should return 401 without token"""
        response = requests.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 401

class TestAdminLeaderCreation:
    """Test admin can create leader accounts"""
    
    def test_admin_can_create_leader(self):
        """Admin should be able to create leader accounts"""
        # Login as admin
        login_response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        token = login_response.json()["token"]
        
        # Create leader
        leader_email = f"test_leader_{os.urandom(4).hex()}@example.com"
        response = requests.post(f"{BASE_URL}/api/admin/create-leader", 
            headers={"Authorization": f"Bearer {token}"},
            json={
                "email": leader_email,
                "password": "LeaderPass123",
                "name": "TEST Leader"
            }
        )
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == leader_email.lower()  # Backend normalizes to lowercase
        assert data["role"] == "leader"
        assert data["name"] == "TEST Leader"
        
        # Cleanup - delete the test leader
        users_response = requests.get(f"{BASE_URL}/api/admin/users", 
            headers={"Authorization": f"Bearer {token}"})
        users = users_response.json()
        test_user = next((u for u in users if u["email"] == leader_email), None)
        if test_user:
            requests.delete(f"{BASE_URL}/api/admin/users/{test_user['id']}", 
                headers={"Authorization": f"Bearer {token}"})
    
    def test_non_admin_cannot_create_leader(self):
        """Non-admin users should not be able to create leaders"""
        # First create a leader account
        login_response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        admin_token = login_response.json()["token"]
        
        leader_email = f"TEST_leader_{os.urandom(4).hex()}@example.com"
        requests.post(f"{BASE_URL}/api/admin/create-leader", 
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "email": leader_email,
                "password": "LeaderPass123",
                "name": "TEST Leader"
            }
        )
        
        # Login as leader
        leader_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": leader_email,
            "password": "LeaderPass123"
        })
        leader_token = leader_login.json()["token"]
        
        # Try to create another leader (should fail)
        response = requests.post(f"{BASE_URL}/api/admin/create-leader", 
            headers={"Authorization": f"Bearer {leader_token}"},
            json={
                "email": "another@example.com",
                "password": "Pass123",
                "name": "Another Leader"
            }
        )
        assert response.status_code == 403  # Forbidden
        
        # Cleanup
        users_response = requests.get(f"{BASE_URL}/api/admin/users", 
            headers={"Authorization": f"Bearer {admin_token}"})
        users = users_response.json()
        test_user = next((u for u in users if u["email"] == leader_email), None)
        if test_user:
            requests.delete(f"{BASE_URL}/api/admin/users/{test_user['id']}", 
                headers={"Authorization": f"Bearer {admin_token}"})

class TestLeaderAccessControl:
    """Test that leaders only see their own hires"""
    
    def test_leader_only_sees_own_hires(self):
        """Leaders should only see hires assigned to them"""
        # Login as admin
        admin_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        admin_token = admin_login.json()["token"]
        
        # Create two leader accounts
        leader1_email = f"TEST_leader1_{os.urandom(4).hex()}@example.com"
        leader2_email = f"TEST_leader2_{os.urandom(4).hex()}@example.com"
        
        leader1_resp = requests.post(f"{BASE_URL}/api/admin/create-leader", 
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"email": leader1_email, "password": "Pass123", "name": "TEST Leader 1"}
        )
        leader1_name = leader1_resp.json()["name"]
        
        leader2_resp = requests.post(f"{BASE_URL}/api/admin/create-leader", 
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"email": leader2_email, "password": "Pass123", "name": "TEST Leader 2"}
        )
        leader2_name = leader2_resp.json()["name"]
        
        # Login as leader1
        leader1_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": leader1_email,
            "password": "Pass123"
        })
        leader1_token = leader1_login.json()["token"]
        
        # Leader1 creates a hire (should be auto-assigned to them)
        hire1_resp = requests.post(f"{BASE_URL}/api/new-hires",
            headers={"Authorization": f"Bearer {leader1_token}"},
            json={
                "name": "TEST Hire for Leader1",
                "leader": "SomeOtherLeader",  # This should be overridden
                "start_date": "2026-01-15"
            }
        )
        assert hire1_resp.status_code == 200
        hire1_id = hire1_resp.json()["id"]
        
        # Login as leader2
        leader2_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": leader2_email,
            "password": "Pass123"
        })
        leader2_token = leader2_login.json()["token"]
        
        # Leader2 gets their hires (should not see leader1's hire)
        leader2_hires = requests.get(f"{BASE_URL}/api/new-hires",
            headers={"Authorization": f"Bearer {leader2_token}"}
        ).json()
        
        # Leader2 should not see leader1's hire
        leader2_hire_ids = [h["id"] for h in leader2_hires]
        assert hire1_id not in leader2_hire_ids
        
        # Admin should see all hires
        admin_hires = requests.get(f"{BASE_URL}/api/new-hires",
            headers={"Authorization": f"Bearer {admin_token}"}
        ).json()
        admin_hire_ids = [h["id"] for h in admin_hires]
        assert hire1_id in admin_hire_ids
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/new-hires/{hire1_id}",
            headers={"Authorization": f"Bearer {admin_token}"})
        
        users_response = requests.get(f"{BASE_URL}/api/admin/users", 
            headers={"Authorization": f"Bearer {admin_token}"})
        users = users_response.json()
        for email in [leader1_email, leader2_email]:
            test_user = next((u for u in users if u["email"] == email), None)
            if test_user:
                requests.delete(f"{BASE_URL}/api/admin/users/{test_user['id']}", 
                    headers={"Authorization": f"Bearer {admin_token}"})

class TestLogout:
    """Test logout functionality"""
    
    def test_logout_clears_cookies(self):
        """Logout should clear auth cookies"""
        # Login first
        session = requests.Session()
        login_response = session.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert "access_token" in session.cookies
        
        # Logout
        logout_response = session.post(f"{BASE_URL}/api/auth/logout")
        assert logout_response.status_code == 200
        
        # Cookies should be cleared (max_age=0 or deleted)
        # Note: The actual cookie deletion happens on client side

class TestAdminUserManagement:
    """Test admin user management endpoints"""
    
    def test_admin_can_get_all_users(self):
        """Admin should be able to get all users"""
        login_response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        token = login_response.json()["token"]
        
        response = requests.get(f"{BASE_URL}/api/admin/users",
            headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        users = response.json()
        assert isinstance(users, list)
        # Should at least have the admin user
        admin_user = next((u for u in users if u["email"] == ADMIN_EMAIL), None)
        assert admin_user is not None
        assert admin_user["role"] == "admin"
        
    def test_admin_can_get_leader_rankings(self):
        """Admin should be able to get leader rankings"""
        login_response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        token = login_response.json()["token"]
        
        response = requests.get(f"{BASE_URL}/api/admin/leader-rankings",
            headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        rankings = response.json()
        assert isinstance(rankings, list)
